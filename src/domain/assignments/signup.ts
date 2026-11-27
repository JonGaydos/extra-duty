import { and, asc, eq, gte, inArray, isNull, lte, max, sql } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import {
  assignments,
  jobPositions,
  jobs,
  jobWatches,
  positionTypes,
  qualifications,
  ranks,
  seasons,
  userQualifications,
  spotOffers,
  users,
  vendors,
} from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { realBillingLockReader } from "../billing/lock";
import { evaluateCaps } from "../caps/caps";
import { evaluateSignup, type EligibilityContext, type EligibilityResult } from "../eligibility/eligibility";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError, type CheckResult } from "../errors";
import { emit } from "../notifications/notify";
import { scheduleShiftsForCaps } from "../planning/schedule";
import { getSettings, type AgencySettings } from "../settings/settings";
import { validatePlannedTimes } from "../jobs/status";
import { readW9Lock } from "../w9/requests";
import { isRestricted } from "./restrictions";

export type Assignment = typeof assignments.$inferSelect;
export type JobWatch = typeof jobWatches.$inferSelect;
export type Job = typeof jobs.$inferSelect;

export type BillingLockReader = (
  tx: Tx,
  userId: string,
  now: Date,
) => Promise<{ locked: boolean; unbilledCount: number; unacknowledgedCount: number }>;

const readBillingLock: BillingLockReader = realBillingLockReader;

const ALREADY_ON_JOB: CheckResult = { check: "already_on_job", ok: false, message: "You are already on this detail" };
export const FULL_CHECK: CheckResult = { check: "state", ok: false, message: "This position is full" };
const STALE_WARNING: CheckResult = { check: "state", ok: false, message: "Read and accept the current sign-up warning" };
const OFFER_GATE: CheckResult = { check: "state", ok: false, message: "Backups have first chance at this spot" };
const SPOT_OPEN: CheckResult = { check: "state", ok: false, message: "This position has open spots. Sign up instead." };
const SHORT_DECLINED = "Filled by full-length sign-ups";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type PositionInfo = {
  id: string;
  jobId: string;
  count: number;
  name: string;
  eligibleRankIds: string[];
  eligibleRankNames: string[];
  requiredQualificationIds: string[];
  requiredQualificationNames: string[];
};

export async function loadPosition(tx: Tx, jobPositionId: string): Promise<PositionInfo> {
  const [row] = await tx
    .select({ pos: jobPositions, type: positionTypes })
    .from(jobPositions)
    .innerJoin(positionTypes, eq(jobPositions.positionTypeId, positionTypes.id))
    .where(eq(jobPositions.id, jobPositionId));
  if (!row) throw new NotFoundError("Position not found.");
  const rankIds = row.pos.eligibleRankIdsOverride ?? row.type.eligibleRankIds;
  const qualIds = row.pos.requiredQualificationIdsOverride ?? row.type.requiredQualificationIds;
  const rankRows = rankIds.length
    ? await tx.select({ id: ranks.id, name: ranks.name }).from(ranks).where(inArray(ranks.id, rankIds)).orderBy(asc(ranks.sortOrder))
    : [];
  const qualRows = qualIds.length
    ? await tx.select({ id: qualifications.id, name: qualifications.name }).from(qualifications).where(inArray(qualifications.id, qualIds))
    : [];
  const qualName = new Map(qualRows.map((q) => [q.id, q.name]));
  return {
    id: row.pos.id,
    jobId: row.pos.jobId,
    count: row.pos.count,
    name: row.type.name,
    eligibleRankIds: rankIds,
    eligibleRankNames: rankRows.map((r) => r.name),
    requiredQualificationIds: qualIds,
    requiredQualificationNames: qualIds.map((id) => qualName.get(id) ?? id),
  };
}

export async function lockJob(tx: Tx, jobId: string): Promise<Job> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job) throw new NotFoundError("Job not found.");
  return job;
}

/**
 * Lock order everywhere: the person's advisory lock first, then the job row. This serializes one person's
 * sign-ups so overlap and cap checks cannot race. Code that already holds a job row lock (the confirm
 * tick) must never wait for a person lock: it uses tryLockUser and skips the row when it is busy.
 */
export async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
}

async function tryLockUser(tx: Tx, userId: string): Promise<boolean> {
  const res = await tx.execute(sql`select pg_try_advisory_xact_lock(hashtext(${userId})) as ok`);
  return (res.rows[0] as { ok: boolean }).ok;
}

export async function signedUpCount(tx: Tx, positionId: string): Promise<number> {
  const rows = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobPositionId, positionId), eq(assignments.status, "signed_up")));
  return rows.length;
}

async function nextBackupPosition(tx: Tx, positionId: string): Promise<number> {
  const [row] = await tx
    .select({ top: max(assignments.backupPosition) })
    .from(assignments)
    .where(and(eq(assignments.jobPositionId, positionId), eq(assignments.status, "backup")));
  return (row?.top ?? 0) + 1;
}

export type ContextArgs = {
  userId: string;
  job: Job;
  position: PositionInfo;
  free: number;
  planned: { startAt: Date; endAt: Date };
  now: Date;
  settings: AgencySettings;
  /** Leave out the person's own assignment (a planned-times change). */
  excludeAssignmentId?: string;
  /** Count the person's other pending_short requests (false in the confirm tick). */
  includePending: boolean;
};

export async function buildContext(tx: Tx, a: ContextArgs): Promise<EligibilityContext> {
  const { job, planned, settings } = a;
  const [user] = await tx.select().from(users).where(eq(users.id, a.userId));
  if (!user) throw new NotFoundError("User not found.");
  const [vendor] = await tx.select({ paymentHold: vendors.paymentHold }).from(vendors).where(eq(vendors.id, job.vendorId));
  const quals = await tx
    .select({ id: userQualifications.qualificationId })
    .from(userQualifications)
    .where(and(eq(userQualifications.userId, a.userId), isNull(userQualifications.revokedAt)));
  // Month caps reach back up to 31 days, so load a margin either side of the candidate.
  const lo = new Date(planned.startAt.getTime() - 32 * DAY_MS);
  const hi = new Date(planned.endAt.getTime() + 32 * DAY_MS);
  const rows = await tx
    .select({ a: assignments, jobNumber: jobs.number, jobStart: jobs.startAt, jobEnd: jobs.endAt })
    .from(assignments)
    .innerJoin(jobs, eq(assignments.jobId, jobs.id))
    .where(
      and(
        eq(assignments.userId, a.userId),
        inArray(assignments.status, ["pending_short", "signed_up", "backup", "billed", "paid"]),
        gte(jobs.startAt, lo),
        lte(jobs.startAt, hi),
      ),
    );
  const mine = rows
    .filter((r) => r.a.id !== a.excludeAssignmentId)
    .filter((r) => a.includePending || r.a.status !== "pending_short")
    .map((r) => ({
      jobId: r.a.jobId,
      jobNumber: r.jobNumber,
      status: r.a.status,
      startAt: r.a.plannedStartAt ?? r.jobStart,
      endAt: r.a.plannedEndAt ?? r.jobEnd,
    }));
  // Hours that count toward caps: held spots and finished details (details_only mode).
  const existing = mine
    .filter((m) => m.jobId !== job.id && m.status !== "backup")
    .map((m) => ({ startAt: m.startAt, endAt: m.endAt }));
  // Agency setting: the person's own work-schedule shifts (not calendar events, not buffers) count too. They stay private.
  if (settings.capHoursMode === "details_plus_schedule") existing.push(...(await scheduleShiftsForCaps(tx, a.userId, lo, hi)));
  const seasonRows = await tx.select().from(seasons);
  const caps = evaluateCaps({
    existing,
    candidate: planned,
    seasons: seasonRows,
    weekStartsOn: settings.weekStartsOn,
    rollingWindowHours: settings.rollingCapWindowHours,
  });

  return {
    now: a.now,
    job: {
      id: job.id,
      number: job.number,
      vendorId: job.vendorId,
      startAt: planned.startAt,
      endAt: planned.endAt,
      realStartAt: job.startAt,
      state: job.state,
      held: job.held,
      releaseAt: job.releaseAt,
      vendorOnPaymentHold: vendor?.paymentHold ?? false,
    },
    position: {
      name: a.position.name,
      eligibleRankIds: a.position.eligibleRankIds,
      eligibleRankNames: a.position.eligibleRankNames,
      requiredQualificationIds: a.position.requiredQualificationIds,
      requiredQualificationNames: a.position.requiredQualificationNames,
      free: a.free,
    },
    person: {
      active: user.active,
      suspendedUntil: user.suspendedUntil,
      rankId: user.rankId ?? "",
      qualificationIds: quals.map((q) => q.id),
    },
    personAssignments: mine.map((m) => ({
      jobId: m.jobId,
      jobNumber: m.jobNumber,
      startAt: m.startAt,
      endAt: m.endAt,
      status: m.status,
    })),
    billingLock: await readBillingLock(tx, a.userId, a.now),
    w9Lock: await readW9Lock(tx, a.userId, a.now),
    caps,
    restrictedFromVendor: await isRestricted(tx, a.userId, job.vendorId),
    rollingWindowHours: settings.rollingCapWindowHours,
  };
}

export type SpotOffer = typeof spotOffers.$inferSelect;

/** Whether the person is entitled to the open offer: the offered backup (sequential) or any backup (all_backups). */
export async function entitledToOffer(tx: Tx, offer: SpotOffer, userId: string): Promise<boolean> {
  const [mine] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobPositionId, offer.jobPositionId), eq(assignments.userId, userId), eq(assignments.status, "backup")));
  if (!mine) return false;
  return offer.mode === "all_backups" || offer.offeredToAssignmentId === mine.id;
}

/**
 * Spots on the position held by open offers that exclude the person: each open offer holds one spot, so free
 * spots for this person = slot count - signed_up - held.
 */
export async function heldByOffers(tx: Tx, positionId: string, userId: string): Promise<number> {
  const open = await tx
    .select()
    .from(spotOffers)
    .where(and(eq(spotOffers.jobPositionId, positionId), eq(spotOffers.status, "open")));
  let held = 0;
  // Sequential: reads in the caller's transaction (one connection).
  for (const o of open) if (!(await entitledToOffer(tx, o, userId))) held++;
  return held;
}

/** The (job, user) unique index backs up already_on_job when two requests race. */
export async function insertAssignment(tx: Tx, values: typeof assignments.$inferInsert): Promise<Assignment> {
  try {
    const [row] = await tx.insert(assignments).values(values).returning();
    return row;
  } catch (e) {
    const err = e as { code?: string; cause?: { code?: string } };
    if ((err.cause?.code ?? err.code) === "23505") throw new RuleViolation([ALREADY_ON_JOB]);
    throw e;
  }
}

export const failing = (r: EligibilityResult) => r.checks.filter((c) => !c.ok);

export type SignUpInput = {
  warningVersion: number;
  plannedStartAt?: Date;
  plannedEndAt?: Date;
  /** When given, the position must belong to this job. */
  jobId?: string;
  /** Test hook and worker clock; defaults to the current time. */
  now?: Date;
};

/** Resolves the job with a light query, locks it, then reads the position so its count is read under the lock. */
export async function loadLocked(tx: Tx, jobPositionId: string, expectJobId?: string) {
  const [ref] = await tx.select({ jobId: jobPositions.jobId }).from(jobPositions).where(eq(jobPositions.id, jobPositionId));
  if (!ref || (expectJobId !== undefined && ref.jobId !== expectJobId)) throw new NotFoundError("Position not found.");
  const job = await lockJob(tx, ref.jobId);
  const position = await loadPosition(tx, jobPositionId);
  return { position, job };
}

export function assertWarning(settings: AgencySettings, version: number): void {
  if (version !== settings.signupWarningVersion) throw new RuleViolation([STALE_WARNING]);
}

/** Ends the person's open watch on the job (the actor's own unless `userId` names the person acted on). */
export async function endOpenWatches(tx: Tx, actor: Actor, jobId: string, now: Date, userId: string = actor.userId): Promise<void> {
  const ended = await tx
    .update(jobWatches)
    .set({ endedAt: now })
    .where(and(eq(jobWatches.userId, userId), eq(jobWatches.jobId, jobId), isNull(jobWatches.endedAt)))
    .returning();
  // Sequential: audit writes in this transaction.
  for (const w of ended) {
    await recordAudit(tx, { actor, action: "job.watch_end", entityType: "job_watch", entityId: w.id, before: w, after: { ...w, endedAt: now } });
  }
}

export async function signUp(actor: Actor, tx: Tx, jobPositionId: string, input: SignUpInput): Promise<Assignment> {
  assertCan(actor, "job.signup");
  const now = input.now ?? new Date();
  await lockUser(tx, actor.userId);
  const { position, job } = await loadLocked(tx, jobPositionId, input.jobId);
  const settings = await getSettings(tx);
  assertWarning(settings, input.warningVersion);
  await settlePending(tx, job, settings, now);

  if ((input.plannedStartAt === undefined) !== (input.plannedEndAt === undefined)) {
    throw new ValidationError("Give both a planned start and a planned end.");
  }
  const planned = { startAt: input.plannedStartAt ?? job.startAt, endAt: input.plannedEndAt ?? job.endAt };
  const { shorter } = validatePlannedTimes(job, planned);

  const free = position.count - (await signedUpCount(tx, position.id));
  const result = evaluateSignup(await buildContext(tx, { userId: actor.userId, job, position, free, planned, now, settings, includePending: true }));
  const problems = failing(result);
  if (free <= 0) problems.push(FULL_CHECK);
  else if (free - (await heldByOffers(tx, position.id, actor.userId)) <= 0) problems.push(OFFER_GATE);
  if (problems.length > 0) throw new RuleViolation(problems);

  const windowOpensAt = job.startAt.getTime() - settings.shortShiftWindowHours * HOUR_MS;
  const status = shorter && now.getTime() < windowOpensAt ? "pending_short" : "signed_up";
  const row = await insertAssignment(tx, {
      jobId: job.id,
      jobPositionId: position.id,
      userId: actor.userId,
      status,
      requestedAt: now,
      warningVersion: String(input.warningVersion),
      warningAcceptedAt: now,
      plannedStartAt: planned.startAt,
      plannedEndAt: planned.endAt,
    });
  await endOpenWatches(tx, actor, job.id, now);
  await recordAudit(tx, { actor, action: "assignment.signup", entityType: "assignment", entityId: row.id, before: null, after: row });
  return row;
}

export async function joinBackup(
  actor: Actor,
  tx: Tx,
  jobPositionId: string,
  input: { warningVersion: number; jobId?: string; now?: Date },
): Promise<Assignment> {
  assertCan(actor, "job.backup");
  const now = input.now ?? new Date();
  await lockUser(tx, actor.userId);
  const { position, job } = await loadLocked(tx, jobPositionId, input.jobId);
  const settings = await getSettings(tx);
  assertWarning(settings, input.warningVersion);
  await settlePending(tx, job, settings, now);

  const free = position.count - (await signedUpCount(tx, position.id));
  const planned = { startAt: job.startAt, endAt: job.endAt };
  const result = evaluateSignup(await buildContext(tx, { userId: actor.userId, job, position, free, planned, now, settings, includePending: true }));
  const problems = failing(result);
  if (free - (await heldByOffers(tx, position.id, actor.userId)) > 0) problems.push(SPOT_OPEN);
  if (problems.length > 0) throw new RuleViolation(problems);

  const row = await insertAssignment(tx, {
      jobId: job.id,
      jobPositionId: position.id,
      userId: actor.userId,
      status: "backup",
      requestedAt: now,
      backupPosition: await nextBackupPosition(tx, position.id),
      warningVersion: String(input.warningVersion),
      warningAcceptedAt: now,
      plannedStartAt: planned.startAt,
      plannedEndAt: planned.endAt,
    });
  await recordAudit(tx, { actor, action: "assignment.backup_join", entityType: "assignment", entityId: row.id, before: null, after: row });
  return row;
}

/** The result with the state check failing as "Backups have first chance at this spot"; nobody else can sign up. */
function withOfferGate(r: EligibilityResult): EligibilityResult {
  const hasState = r.checks.some((c) => c.check === "state");
  const checks = hasState ? r.checks.map((c) => (c.check === "state" && c.ok ? OFFER_GATE : c)) : [OFFER_GATE, ...r.checks];
  return { ...r, checks, canSignUp: false };
}

export type JobEligibility = EligibilityResult & { jobPositionId: string; backupPosition: number };

/** First position the person can sign up for, else the first they can back up, else the first position. */
export async function eligibilityFor(actor: Actor, tx: Tx, jobId: string, now: Date = new Date()): Promise<JobEligibility> {
  const evaluated = await eligibilityByPosition(actor, tx, jobId, now);
  return evaluated.find((e) => e.canSignUp) ?? evaluated.find((e) => e.canBackup) ?? evaluated[0];
}

/** Every position of the job, in order, with the person's checks for each (for a position picker). */
export async function eligibilityByPosition(actor: Actor, tx: Tx, jobId: string, now: Date = new Date()): Promise<JobEligibility[]> {
  assertCan(actor, "job.signup");
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job || (actor.role === "personnel" && (job.state === "requested" || job.state === "declined"))) throw new NotFoundError("Job not found.");
  const positions = await tx
    .select({ id: jobPositions.id })
    .from(jobPositions)
    .where(eq(jobPositions.jobId, jobId))
    .orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  if (positions.length === 0) throw new NotFoundError("This job has no positions.");
  const settings = await getSettings(tx);
  const planned = { startAt: job.startAt, endAt: job.endAt };

  const evaluated: Array<JobEligibility> = [];
  // Sequential: reads in this transaction (one connection), in position order.
  for (const p of positions) {
    const position = await loadPosition(tx, p.id);
    const free = position.count - (await signedUpCount(tx, position.id));
    let r = evaluateSignup(await buildContext(tx, { userId: actor.userId, job, position, free, planned, now, settings, includePending: true }));
    // While open offers hold every free spot, it is a backup's turn: shown as the failing check signUp would give.
    if (free > 0 && free - (await heldByOffers(tx, position.id, actor.userId)) <= 0) r = withOfferGate(r);
    evaluated.push({ ...r, jobPositionId: position.id, backupPosition: r.canBackup ? await nextBackupPosition(tx, position.id) : 0 });
  }
  return evaluated;
}

export async function watchJob(actor: Actor, tx: Tx, jobId: string, now: Date = new Date()): Promise<JobWatch> {
  assertCan(actor, "job.watch");
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new NotFoundError("Job not found.");
  if (actor.role === "personnel" && job.state === "requested") throw new NotFoundError("Job not found.");
  if (job.state === "canceled" || job.state === "declined") throw new ValidationError("This detail is no longer available.");
  if (job.startAt.getTime() <= now.getTime()) throw new ValidationError("This detail has already started.");
  const [existing] = await tx
    .select()
    .from(jobWatches)
    .where(and(eq(jobWatches.userId, actor.userId), eq(jobWatches.jobId, jobId), isNull(jobWatches.endedAt)));
  if (existing) return existing;
  const [row] = await tx.insert(jobWatches).values({ userId: actor.userId, jobId }).returning();
  await recordAudit(tx, { actor, action: "job.watch", entityType: "job_watch", entityId: row.id, before: null, after: row });
  return row;
}

/** Ends the person's open watch. Returns null when there was none. */
export async function unwatchJob(actor: Actor, tx: Tx, jobId: string, now: Date = new Date()): Promise<JobWatch | null> {
  assertCan(actor, "job.watch");
  const [existing] = await tx
    .select()
    .from(jobWatches)
    .where(and(eq(jobWatches.userId, actor.userId), eq(jobWatches.jobId, jobId), isNull(jobWatches.endedAt)));
  if (!existing) return null;
  const [row] = await tx.update(jobWatches).set({ endedAt: now }).where(eq(jobWatches.id, existing.id)).returning();
  await recordAudit(tx, { actor, action: "job.unwatch", entityType: "job_watch", entityId: row.id, before: existing, after: row });
  return row;
}

/** Open watches on a job that has not started; a watch on a started job counts as ended. */
export async function listOpenWatches(tx: Tx, jobId: string, now: Date = new Date()): Promise<JobWatch[]> {
  const rows = await tx
    .select({ w: jobWatches })
    .from(jobWatches)
    .innerJoin(jobs, eq(jobWatches.jobId, jobs.id))
    .where(and(eq(jobWatches.jobId, jobId), isNull(jobWatches.endedAt), sql`${jobs.startAt} > ${now}`));
  return rows.map((r) => r.w);
}

const TIME_CHECKS = new Set<string>(["overlap", "cap_rolling", "cap_week", "cap_month"]);

export async function changePlannedTimes(
  actor: Actor,
  tx: Tx,
  assignmentId: string,
  planned: { startAt: Date; endAt: Date },
  now: Date = new Date(),
): Promise<Assignment> {
  const [first] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!first) throw new NotFoundError("Assignment not found.");
  assertCan(actor, "assignment.cancelOwn", { ownerUserId: first.userId });
  if (first.userId !== actor.userId) throw new ForbiddenError("Only the person on the sign-up can change its times.");
  await lockUser(tx, actor.userId);
  const job = await lockJob(tx, first.jobId);
  const settings = await getSettings(tx);
  await settlePending(tx, job, settings, now);
  const [before] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (before.status !== "pending_short" && before.status !== "signed_up") {
    throw new ValidationError("Only an active sign-up can change its times.");
  }
  const earliest = job.flexEarliestStartAt ?? job.startAt;
  if (now.getTime() >= earliest.getTime()) throw new ValidationError("The detail has already started.");
  const { shorter } = validatePlannedTimes(job, planned);

  const windowOpen = now.getTime() >= job.startAt.getTime() - settings.shortShiftWindowHours * HOUR_MS;
  let status = before.status;
  if (shorter && status === "signed_up" && !windowOpen) {
    throw new ValidationError("A shorter shift must be requested as a new sign-up. Cancel and sign up again.");
  }
  const position = await loadPosition(tx, before.jobPositionId);
  const taken = await signedUpCount(tx, position.id);
  if (status === "pending_short" && !shorter) {
    if (position.count - taken <= 0) throw new RuleViolation([FULL_CHECK]);
    status = "signed_up";
  }
  // Only the time checks are used below, so fullness does not matter here.
  const result = evaluateSignup(
    await buildContext(tx, { userId: before.userId, job, position, free: 1, planned, now, settings, excludeAssignmentId: before.id, includePending: true }),
  );
  const problems = failing(result).filter((c) => TIME_CHECKS.has(c.check));
  if (problems.length > 0) throw new RuleViolation(problems);

  const [after] = await tx
    .update(assignments)
    .set({ plannedStartAt: planned.startAt, plannedEndAt: planned.endAt, status, updatedAt: now })
    .where(eq(assignments.id, before.id))
    .returning();
  await recordAudit(tx, { actor, action: "assignment.change_times", entityType: "assignment", entityId: before.id, before, after });
  return after;
}

/** Runs the confirm step for a locked job when its short-shift window is open and requests are waiting. */
export async function settlePending(tx: Tx, job: Job, settings: AgencySettings, now: Date): Promise<void> {
  if (now.getTime() < job.startAt.getTime() - settings.shortShiftWindowHours * HOUR_MS) return;
  const [any] = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobId, job.id), eq(assignments.status, "pending_short")))
    .limit(1);
  if (any) await confirmJob(tx, job, settings, now);
}

/** Why the overlap and cap checks refuse a pending_short row at its planned times, or null when they pass. */
async function shortTimeProblems(
  tx: Tx,
  a: typeof assignments.$inferSelect,
  ctx: { job: Job; position: Awaited<ReturnType<typeof loadPosition>>; free: number; settings: AgencySettings; now: Date },
): Promise<string | null> {
  const { job, position, free, settings, now } = ctx;
  const planned = { startAt: a.plannedStartAt ?? job.startAt, endAt: a.plannedEndAt ?? job.endAt };
  const result = evaluateSignup(
    await buildContext(tx, { userId: a.userId, job, position, free, planned, now, settings, excludeAssignmentId: a.id, includePending: false }),
  );
  const problems = failing(result).filter((c) => TIME_CHECKS.has(c.check));
  return problems.length > 0 ? problems.map((c) => c.message).join(" ") : null;
}

async function declineShort(tx: Tx, job: Job, a: typeof assignments.$inferSelect, reason: string, now: Date): Promise<void> {
  const [after] = await tx.update(assignments).set({ status: "canceled", removalReason: reason, updatedAt: now }).where(eq(assignments.id, a.id)).returning();
  await recordAudit(tx, { actor: "system", action: "assignment.short_declined", entityType: "assignment", entityId: a.id, before: a, after, reason });
  await emit(tx, { recipients: [a.userId], type: "signup.short_declined", title: `Shorter shift declined: #${job.number} ${job.title}`, body: reason, link: `/jobs/${job.id}` });
}

async function confirmShort(tx: Tx, job: Job, a: typeof assignments.$inferSelect, now: Date): Promise<void> {
  const [after] = await tx.update(assignments).set({ status: "signed_up", updatedAt: now }).where(eq(assignments.id, a.id)).returning();
  await recordAudit(tx, { actor: "system", action: "assignment.short_confirmed", entityType: "assignment", entityId: a.id, before: a, after });
  await emit(tx, { recipients: [a.userId],
    type: "signup.short_confirmed",
    title: `Shorter shift confirmed: #${job.number} ${job.title}`,
    body: "Your shorter shift is confirmed.",
    link: `/jobs/${job.id}`,
  });
}

/**
 * Confirms pending_short sign-ups on a locked job in request order while spots are free and overlap and caps
 * still pass; the rest are canceled. Rows on a started job are declined. A row whose person is busy in another
 * transaction is skipped and retried by the next tick.
 */
async function confirmJob(tx: Tx, job: Job, settings: AgencySettings, now: Date): Promise<{ confirmed: number; declined: number }> {
  let confirmed = 0;
  let declined = 0;
  const pending = await tx
    .select()
    .from(assignments)
    .where(and(eq(assignments.jobId, job.id), eq(assignments.status, "pending_short")))
    .orderBy(asc(assignments.requestedAt), asc(assignments.id));
  // Sequential: each row locks its person and writes in this transaction, in request order.
  for (const a of pending) {
    if (!(await tryLockUser(tx, a.userId))) continue;
    const position = await loadPosition(tx, a.jobPositionId);
    const free = position.count - (await signedUpCount(tx, position.id));
    let reason: string | null = null;
    if (job.startAt.getTime() <= now.getTime()) reason = "This detail has started";
    else if (free <= 0) reason = SHORT_DECLINED;
    if (!reason && free - (await heldByOffers(tx, position.id, a.userId)) <= 0) continue; // backups have first chance; retried by the tick
    reason ??= await shortTimeProblems(tx, a, { job, position, free, settings, now });
    if (reason) {
      await declineShort(tx, job, a, reason, now);
      declined++;
    } else {
      await confirmShort(tx, job, a, now);
      confirmed++;
    }
  }
  return { confirmed, declined };
}

async function processDueJob(tx: Tx, jobId: string, now: Date): Promise<{ confirmed: number; declined: number }> {
  const job = await lockJob(tx, jobId);
  if (job.state !== "scheduled" && job.state !== "active") return { confirmed: 0, declined: 0 };
  return confirmJob(tx, job, await getSettings(tx), now);
}

/**
 * Worker tick (every minute). For jobs whose short-shift window has opened, confirms pending_short sign-ups
 * in request order (see confirmJob). Each due job runs in its own transaction, in job id order, unless a
 * transaction is passed in (tests).
 */
export async function confirmPendingShortTick(now: Date, tx?: Tx): Promise<{ confirmed: number; declined: number }> {
  const horizonHours = (await (tx ? getSettings(tx) : withTx(getSettings))).shortShiftWindowHours;
  const horizon = new Date(now.getTime() + horizonHours * HOUR_MS);
  const dueQuery = (t: Tx) =>
    t
      .selectDistinct({ jobId: assignments.jobId })
      .from(assignments)
      .innerJoin(jobs, eq(assignments.jobId, jobs.id))
      .where(and(eq(assignments.status, "pending_short"), lte(jobs.startAt, horizon), inArray(jobs.state, ["scheduled", "active"])))
      .orderBy(asc(assignments.jobId));
  const due = await (tx ? dueQuery(tx) : withTx(dueQuery));
  const total = { confirmed: 0, declined: 0 };
  // Sequential: one transaction per job, so one failure does not undo the others.
  for (const { jobId } of due) {
    const r = await (tx ? processDueJob(tx, jobId, now) : withTx((t) => processDueJob(t, jobId, now)));
    total.confirmed += r.confirmed;
    total.declined += r.declined;
  }
  return total;
}
