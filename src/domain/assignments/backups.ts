import { and, asc, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, jobPositions, jobs, jobWatches, spotOffers } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { evaluateSignup } from "../eligibility/eligibility";
import { NotFoundError, RuleViolation, ValidationError } from "../errors";
import { withoutHiddenVendor } from "../notifications/audiences";
import { emit } from "../notifications/notify";
import type { NotificationType } from "../notifications/types";
import { getSettings, type AgencySettings } from "../settings/settings";
import {
  FULL_CHECK,
  assertWarning,
  endOpenWatches,
  entitledToOffer,
  heldByOffers,
  buildContext,
  failing,
  loadLocked,
  loadPosition,
  lockUser,
  settlePending,
  signUp,
  signedUpCount,
  type Assignment,
  type Job,
  type PositionInfo,
  type SpotOffer,
} from "./signup";

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

const LEAVABLE = ["signed_up", "backup", "pending_short"] as const;

function openForSignup(job: Job, now: Date): boolean {
  return (job.state === "scheduled" || job.state === "active") && job.startAt.getTime() > now.getTime();
}

async function backupsOf(tx: Tx, positionId: string): Promise<Assignment[]> {
  return tx
    .select()
    .from(assignments)
    .where(and(eq(assignments.jobPositionId, positionId), eq(assignments.status, "backup")))
    .orderBy(asc(assignments.backupPosition), asc(assignments.id));
}

/** Re-numbers the position's remaining backups 1..n in their current order, one audit row per changed row. */
async function renumberBackups(tx: Tx, positionId: string): Promise<void> {
  const rows = await backupsOf(tx, positionId);
  // Sequential: updates and audits in this transaction, in backup order.
  for (const [i, b] of rows.entries()) {
    if (b.backupPosition === i + 1) continue;
    await tx.update(assignments).set({ backupPosition: i + 1 }).where(eq(assignments.id, b.id));
    await recordAudit(tx, {
      actor: "system",
      action: "assignment.backup_renumber",
      entityType: "assignment",
      entityId: b.id,
      before: { backupPosition: b.backupPosition },
      after: { backupPosition: i + 1 },
    });
  }
}

async function jobOfPosition(tx: Tx, positionId: string): Promise<Job> {
  const [row] = await tx
    .select({ job: jobs })
    .from(jobPositions)
    .innerJoin(jobs, eq(jobPositions.jobId, jobs.id))
    .where(eq(jobPositions.id, positionId));
  if (!row) throw new NotFoundError("Position not found.");
  return row.job;
}

async function alertBackups(tx: Tx, job: Job, rows: Assignment[], type: NotificationType, body: string): Promise<void> {
  await emit(tx, { recipients: rows.map((b) => b.userId), type, title: `Spot available: #${job.number} ${job.title}`, body, link: `/jobs/${job.id}` });
}

/**
 * Alerts open watchers on the job who could take a spot now (eligible, unrestricted), once each: the watch
 * then ends. Used when a spot opens to everyone. The caller holds the job lock.
 */
async function alertWatchersOpened(tx: Tx, job: Job, position: PositionInfo, now: Date): Promise<number> {
  const watches = await tx
    .select()
    .from(jobWatches)
    .where(and(eq(jobWatches.jobId, job.id), isNull(jobWatches.endedAt)))
    .orderBy(asc(jobWatches.createdAt), asc(jobWatches.id));
  if (watches.length === 0) return 0;
  const settings = await getSettings(tx);
  const free = position.count - (await signedUpCount(tx, position.id));
  const planned = { startAt: job.startAt, endAt: job.endAt };
  let alerted = 0;
  // A hidden vendor's opening alerts are discovery alerts: skipped, and the watch stays open.
  const visible = new Set(await withoutHiddenVendor(tx, watches.map((w) => w.userId), job.vendorId));
  // Sequential: reads and alert writes in this transaction, in watch order.
  for (const w of watches) {
    if (!visible.has(w.userId)) continue;
    const net = free - (await heldByOffers(tx, position.id, w.userId));
    if (net <= 0) continue;
    const result = evaluateSignup(await buildContext(tx, { userId: w.userId, job, position, free: net, planned, now, settings, includePending: true }));
    if (!result.canSignUp) continue;
    await endWatchAlerted(tx, w, now);
    await emit(tx, { recipients: [w.userId],
      type: "job.watch_opened",
      title: `A spot opened: #${job.number} ${job.title}`,
      body: `A spot is open for ${position.name}. First come, first served.`,
      link: `/jobs/${job.id}`,
    });
    alerted++;
  }
  return alerted;
}

export async function endWatchAlerted(tx: Tx, w: typeof jobWatches.$inferSelect, now: Date): Promise<void> {
  const [after] = await tx.update(jobWatches).set({ endedAt: now }).where(eq(jobWatches.id, w.id)).returning();
  await recordAudit(tx, { actor: "system", action: "job.watch_alerted", entityType: "job_watch", entityId: w.id, before: w, after });
}

async function createOffer(
  tx: Tx,
  job: Job,
  position: PositionInfo,
  settings: AgencySettings,
  now: Date,
  mode: "sequential" | "all_backups",
  targets: Assignment[],
): Promise<SpotOffer> {
  const [offer] = await tx
    .insert(spotOffers)
    .values({
      jobPositionId: position.id,
      mode,
      offeredToAssignmentId: mode === "sequential" ? targets[0].id : null,
      endsAt: new Date(now.getTime() + settings.backupWindowMinutes * MINUTE_MS),
    })
    .returning();
  await recordAudit(tx, { actor: "system", action: "spot_offer.create", entityType: "spot_offer", entityId: offer.id, before: null, after: offer });
  await alertBackups(tx, job, targets, "spot.offered", `A spot opened for ${position.name}. You have ${settings.backupWindowMinutes} minutes to claim it.`);
  return offer;
}

export async function expireOffer(tx: Tx, offer: SpotOffer, status: "expired" | "accepted"): Promise<void> {
  const [after] = await tx.update(spotOffers).set({ status }).where(eq(spotOffers.id, offer.id)).returning();
  await recordAudit(tx, { actor: "system", action: `spot_offer.${status}`, entityType: "spot_offer", entityId: offer.id, before: offer, after });
}

async function openOffers(tx: Tx, positionId: string): Promise<SpotOffer[]> {
  return tx
    .select()
    .from(spotOffers)
    .where(and(eq(spotOffers.jobPositionId, positionId), eq(spotOffers.status, "open")))
    .orderBy(asc(spotOffers.createdAt), asc(spotOffers.id));
}

/**
 * Hands one freed spot on: inside the first-come window, or in everyone mode, or with no backup to offer it to,
 * it opens to everyone (alerting backups only in the first-come case, and eligible watchers). Otherwise it gets
 * its own offer. `after` skips backups at or before that list position (sequential chain); `skipOffers` reopens to
 * everyone (an expired all_backups offer). Returns true when the spot went to everyone.
 */
async function openOne(
  tx: Tx,
  job: Job,
  position: PositionInfo,
  settings: AgencySettings,
  now: Date,
  o: { after: number; skipOffers: boolean },
): Promise<boolean> {
  const backups = await backupsOf(tx, position.id);
  if (job.startAt.getTime() - now.getTime() <= settings.backupFirstComeHours * HOUR_MS) {
    await alertBackups(tx, job, backups, "spot.opened_first_come", `A spot opened for ${position.name}. First come, first served.`);
    await alertWatchersOpened(tx, job, position, now);
    return true;
  }
  if (o.skipOffers || settings.backupOfferMode === "everyone" || backups.length === 0) {
    await alertWatchersOpened(tx, job, position, now);
    return true;
  }
  if (settings.backupOfferMode === "all_backups") {
    await createOffer(tx, job, position, settings, now, "all_backups", backups);
    return false;
  }
  const busy = new Set((await openOffers(tx, position.id)).map((x) => x.offeredToAssignmentId));
  const next = backups.find((b) => (b.backupPosition ?? 0) > o.after && !busy.has(b.id));
  if (!next) {
    await alertWatchersOpened(tx, job, position, now);
    return true;
  }
  await createOffer(tx, job, position, settings, now, "sequential", [next]);
  return false;
}

/** Ends the offer and hands its spot on: the next backup in order (sequential) or everyone. */
async function advanceOffer(tx: Tx, job: Job, position: PositionInfo, offer: SpotOffer, afterBackupPosition: number, now: Date): Promise<void> {
  await expireOffer(tx, offer, "expired");
  const settings = await getSettings(tx);
  await openOne(tx, job, position, settings, now, { after: afterBackupPosition, skipOffers: offer.mode === "all_backups" });
}

/**
 * One spot freed on the position (call once per spot actually freed). Caller holds the job lock. It is offered to
 * the next backup who holds no offer (sequential), to all backups (all_backups), or opened to everyone. Does
 * nothing when the job is closed or started, or when open offers already hold every free spot.
 */
async function openSpot(tx: Tx, jobPositionId: string, now: Date): Promise<void> {
  const job = await jobOfPosition(tx, jobPositionId);
  if (!openForSignup(job, now)) return;
  const position = await loadPosition(tx, jobPositionId);
  const free = position.count - (await signedUpCount(tx, position.id));
  if (free - (await openOffers(tx, position.id)).length <= 0) return;
  const settings = await getSettings(tx);
  await openOne(tx, job, position, settings, now, { after: 0, skipOffers: false });
}

/** After a row leaves the list (caller holds the job lock): a signed_up row opens a spot; an offered backup passes the turn on. */
async function afterLeave(tx: Tx, before: Assignment, now: Date): Promise<void> {
  if (before.status === "signed_up") {
    await openSpot(tx, before.jobPositionId, now);
    return;
  }
  if (before.status !== "backup") return;
  const job = await jobOfPosition(tx, before.jobPositionId);
  if (!openForSignup(job, now)) return;
  const offers = await openOffers(tx, before.jobPositionId);
  const mine = offers.find((x) => x.mode === "sequential" && x.offeredToAssignmentId === before.id);
  if (mine) await advanceOffer(tx, job, await loadPosition(tx, before.jobPositionId), mine, before.backupPosition ?? 0, now);
}

export type LeaveOptions = {
  status: "canceled" | "removed";
  auditAction: string;
  reason: string;
  removalReason?: string;
  /** Coordinator-only: when set, the removed person gets an assignment.removed notice with this body, sent as mandatory (ignores preferences and quiet hours). */
  notifyBody?: string;
  /** The notice's title; "You were removed from a detail" when not given. */
  notifyTitle?: string;
  now: Date;
  /** Checked under the locks, after the row is read. */
  guard?: (before: Assignment, job: Job) => void;
};

/**
 * Moves a pending, signed_up or backup row out of the list. Takes the person's lock, then the job row, then
 * handles the freed spot. Returns the updated row.
 */
export async function leaveAssignment(actor: Actor, tx: Tx, assignmentId: string, o: LeaveOptions): Promise<Assignment> {
  const [first] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!first) throw new NotFoundError("Assignment not found.");
  await lockUser(tx, first.userId);
  const { job } = await loadLocked(tx, first.jobPositionId);
  const [before] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!(LEAVABLE as readonly string[]).includes(before.status)) throw new ValidationError("This sign-up is no longer active.");
  o.guard?.(before, job);
  const [after] = await tx
    .update(assignments)
    .set({ status: o.status, backupPosition: null, removalReason: o.removalReason ?? before.removalReason, updatedAt: o.now })
    .where(eq(assignments.id, assignmentId))
    .returning();
  await recordAudit(tx, { actor, action: o.auditAction, entityType: "assignment", entityId: assignmentId, before, after, reason: o.reason });
  await afterLeave(tx, before, o.now);
  if (before.status === "backup") await renumberBackups(tx, before.jobPositionId);
  if (o.notifyBody) {
    await emit(tx, { recipients: [before.userId], type: "assignment.removed", mandatory: true, title: o.notifyTitle ?? "You were removed from a detail", body: o.notifyBody, link: `/jobs/${job.id}` });
  }
  return after;
}

/**
 * The position a backup can take a free spot on now, or null: the detail is still open for sign-up and a spot is
 * free that no open offer keeps from them (their own offer, an all-backups offer, or no offer at all). claimSpot
 * checks the sign-up rules on top.
 */
export async function claimablePositionId(tx: Tx, assignmentId: string, now: Date): Promise<string | null> {
  const [a] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (a?.status !== "backup") return null;
  if (!openForSignup(await jobOfPosition(tx, a.jobPositionId), now)) return null;
  const position = await loadPosition(tx, a.jobPositionId);
  const free = position.count - (await signedUpCount(tx, position.id));
  return free - (await heldByOffers(tx, position.id, a.userId)) > 0 ? position.id : null;
}

export type ClaimInput = { warningVersion?: number; jobId?: string; now?: Date };

/**
 * Claims a free spot. A backup converts their own row into signed_up; they may take any free spot not held by
 * an offer that excludes them (sequential: their own offer; all_backups: any offer). Anyone else goes through
 * the sign-up rules, which refuse while open offers hold every free spot.
 */
export async function claimSpot(actor: Actor, tx: Tx, jobPositionId: string, input: ClaimInput = {}): Promise<Assignment> {
  assertCan(actor, "job.signup");
  const now = input.now ?? new Date();
  await lockUser(tx, actor.userId);
  const { position, job } = await loadLocked(tx, jobPositionId, input.jobId);
  const [mine] = await tx
    .select()
    .from(assignments)
    .where(and(eq(assignments.jobPositionId, position.id), eq(assignments.userId, actor.userId), eq(assignments.status, "backup")));
  if (!mine) return signUp(actor, tx, jobPositionId, { warningVersion: input.warningVersion ?? 0, jobId: input.jobId, now });

  const settings = await getSettings(tx);
  assertWarning(settings, input.warningVersion ?? 0);
  await settlePending(tx, job, settings, now);
  const free = position.count - (await signedUpCount(tx, position.id));
  const problems = failing(
    evaluateSignup(
      await buildContext(tx, {
        userId: actor.userId,
        job,
        position,
        free,
        planned: { startAt: job.startAt, endAt: job.endAt },
        now,
        settings,
        excludeAssignmentId: mine.id,
        includePending: true,
      }),
    ),
  );
  if (free <= 0) problems.push(FULL_CHECK);
  else if (free - (await heldByOffers(tx, position.id, actor.userId)) <= 0) {
    problems.push({ check: "state", ok: false, message: "It is not your turn for this spot" });
  }
  if (problems.length > 0) throw new RuleViolation(problems);

  let used: SpotOffer | undefined;
  // Sequential: stops at the first offer the person is entitled to.
  for (const o of await openOffers(tx, position.id)) {
    if (await entitledToOffer(tx, o, actor.userId)) {
      used = o;
      break;
    }
  }
  const [after] = await tx
    .update(assignments)
    .set({ status: "signed_up", backupPosition: null, updatedAt: now })
    .where(eq(assignments.id, mine.id))
    .returning();
  await recordAudit(tx, { actor, action: "assignment.claim", entityType: "assignment", entityId: mine.id, before: mine, after });
  await endOpenWatches(tx, actor, job.id, now);
  await renumberBackups(tx, position.id);
  if (used) {
    await expireOffer(tx, used, "accepted");
  }
  return after;
}

export async function listOpenOfferJobIds(tx: Tx): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ jobId: jobPositions.jobId })
    .from(spotOffers)
    .innerJoin(jobPositions, eq(spotOffers.jobPositionId, jobPositions.id))
    .where(eq(spotOffers.status, "open"))
    .orderBy(asc(jobPositions.jobId));
  return rows.map((r) => r.jobId);
}

/** Runs the offer step for one locked job. Returns how many offers ended. */
export async function processJobOffers(tx: Tx, job: Job, now: Date): Promise<number> {
  const offers = await tx
    .select({ offer: spotOffers })
    .from(spotOffers)
    .innerJoin(jobPositions, eq(spotOffers.jobPositionId, jobPositions.id))
    .where(and(eq(jobPositions.jobId, job.id), eq(spotOffers.status, "open")))
    .orderBy(asc(spotOffers.createdAt), asc(spotOffers.id));
  const settings = await getSettings(tx);
  let ended = 0;
  const firstCome = new Map<string, PositionInfo>();
  // Sequential: each offer is ended or advanced in this transaction, and later ones see the spots it freed.
  for (const { offer } of offers) {
    const position = await loadPosition(tx, offer.jobPositionId);
    const free = position.count - (await signedUpCount(tx, position.id));
    const firstComeAt = job.startAt.getTime() - settings.backupFirstComeHours * HOUR_MS;
    if (!openForSignup(job, now) || free <= 0) {
      await expireOffer(tx, offer, "expired");
      ended++;
    } else if (now.getTime() >= firstComeAt) {
      await expireOffer(tx, offer, "expired");
      firstCome.set(position.id, position);
      ended++;
    } else if (offer.endsAt.getTime() <= now.getTime()) {
      let after = 0;
      if (offer.offeredToAssignmentId) {
        const [offered] = await tx.select().from(assignments).where(eq(assignments.id, offer.offeredToAssignmentId));
        after = offered?.backupPosition ?? 0;
      }
      await advanceOffer(tx, job, position, offer, after, now);
      ended++;
    }
  }
  // Alert once per position, however many offers ended.
  // Sequential: alert writes in this transaction.
  for (const position of firstCome.values()) {
    await alertBackups(tx, job, await backupsOf(tx, position.id), "spot.opened_first_come", `A spot opened for ${position.name}. First come, first served.`);
    await alertWatchersOpened(tx, job, position, now);
  }
  return ended;
}

