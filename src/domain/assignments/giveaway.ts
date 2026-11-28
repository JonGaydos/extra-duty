import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import { assignments, jobs, spotGiveaways, users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { assignmentVendorId } from "../auth/scope";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { emit } from "../notifications/notify";
import { getSettings } from "../settings/settings";
import { AGENCY_TZ } from "../time/agency-time";
import { endSurplusOffers, openSpot } from "./backups";
import { assignPerson } from "./coordinator";
import { loadLocked, lockUser, signedUpCount, type Assignment, type Job, type SpotGiveaway } from "./signup";

const HOUR_MS = 3_600_000;
const day = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, month: "short", day: "numeric" }).format(d);

const STARTED = "This detail has started. Ask a coordinator to remove you.";
const CONFIDENTIAL = "A confidential detail is never offered to others. Ask a coordinator if you cannot work it.";

async function openOf(tx: Tx, assignmentId: string): Promise<SpotGiveaway | undefined> {
  const [g] = await tx
    .select()
    .from(spotGiveaways)
    .where(and(eq(spotGiveaways.assignmentId, assignmentId), eq(spotGiveaways.status, "open")));
  return g;
}

/** Reads the sign-up and takes its person's lock, then the job row (the usual lock order). */
async function lockSignup(tx: Tx, assignmentId: string): Promise<{ row: Assignment; job: Job; position: Awaited<ReturnType<typeof loadLocked>>["position"] }> {
  const [first] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!first) throw new NotFoundError("Assignment not found.");
  await lockUser(tx, first.userId);
  const { job, position } = await loadLocked(tx, first.jobPositionId);
  const [row] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  return { row, job, position };
}

/**
 * The deputy offers their spot to someone else (owner decision 2026-11-27). They stay signed up and responsible
 * until someone takes it over; the spot is handed on as a freed spot is (backups first, then everyone eligible).
 * Never on a confidential detail, which is never offered to others, and never once the detail has started.
 */
export async function offerSpot(actor: Actor, tx: Tx, assignmentId: string, reason: string, now: Date = new Date()): Promise<SpotGiveaway> {
  const [first] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!first) throw new NotFoundError("Assignment not found.");
  assertCan(actor, "assignment.cancelOwn", { ownerUserId: first.userId });
  if (first.userId !== actor.userId) throw new ForbiddenError("Only the person on the sign-up can give the spot away.");
  const why = reason?.trim();
  if (!why) throw new ValidationError("A reason is required.");
  const { row, job, position } = await lockSignup(tx, assignmentId);
  if (row.status !== "signed_up") throw new ValidationError("Only a spot you are signed up for can be given away.");
  if (job.confidential) throw new ValidationError(CONFIDENTIAL);
  if (job.state !== "scheduled" && job.state !== "active") throw new ValidationError("This detail is no longer open.");
  if (now.getTime() >= job.startAt.getTime()) throw new ValidationError(STARTED);
  if (await openOf(tx, assignmentId)) throw new ValidationError("Your spot is already offered.");
  const [g] = await tx.insert(spotGiveaways).values({ assignmentId, jobPositionId: position.id, reason: why, createdAt: now }).returning();
  await recordAudit(tx, { actor, action: "assignment.offer", entityType: "assignment", entityId: assignmentId, before: row, after: { ...row, giveaway: g }, reason: why });
  await openSpot(tx, position.id, now);
  return g;
}

/**
 * Ends an open offer with the deputy keeping the spot: they withdraw it, or staff cancel it. Offers to backups the
 * spot no longer leaves room for end, and those backups are told.
 */
async function endOffer(actor: Actor, tx: Tx, assignmentId: string, o: { status: "withdrawn" | "canceled"; action: string; reason?: string; now: Date }): Promise<SpotGiveaway> {
  const { row, job, position } = await lockSignup(tx, assignmentId);
  const g = row.status === "signed_up" ? await openOf(tx, assignmentId) : undefined;
  if (!g) throw new ValidationError(row.status === "canceled" ? "This spot was already taken over." : "There is no open offer on this sign-up.");
  const [after] = await tx.update(spotGiveaways).set({ status: o.status, endedAt: o.now, endedBy: actor.userId }).where(eq(spotGiveaways.id, g.id)).returning();
  await recordAudit(tx, { actor, action: o.action, entityType: "assignment", entityId: assignmentId, before: { ...row, giveaway: g }, after: { ...row, giveaway: after }, reason: o.reason });
  const free = position.count - (await signedUpCount(tx, position.id));
  await endSurplusOffers(tx, job, position, free, `The deputy kept the spot for ${position.name}.`);
  return after;
}

/** The deputy withdraws their own offer while nobody has taken it. */
export async function withdrawOffer(actor: Actor, tx: Tx, assignmentId: string, now: Date = new Date()): Promise<SpotGiveaway> {
  const [first] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!first) throw new NotFoundError("Assignment not found.");
  assertCan(actor, "assignment.cancelOwn", { ownerUserId: first.userId });
  if (first.userId !== actor.userId) throw new ForbiddenError("Only the person on the sign-up can withdraw the offer.");
  return endOffer(actor, tx, assignmentId, { status: "withdrawn", action: "assignment.offer_withdraw", now });
}

/** Staff (or the vendor's manager) cancel a deputy's offer: the deputy keeps the spot and is told. */
export async function cancelOffer(actor: Actor, tx: Tx, assignmentId: string, now: Date = new Date()): Promise<SpotGiveaway> {
  assertCan(actor, "assignment.remove", { vendorId: await assignmentVendorId(tx, assignmentId) });
  const g = await endOffer(actor, tx, assignmentId, { status: "canceled", action: "assignment.offer_cancel", now });
  const [row] = await tx.select({ userId: assignments.userId, jobId: assignments.jobId, number: jobs.number, title: jobs.title }).from(assignments).innerJoin(jobs, eq(jobs.id, assignments.jobId)).where(eq(assignments.id, assignmentId));
  await emit(tx, {
    recipients: [row.userId],
    type: "giveaway.canceled",
    title: `Your offer was canceled: #${row.number} ${row.title}`,
    body: "A coordinator canceled your offer to give this spot away. You stay on this detail and are expected to work it.",
    link: `/jobs/${row.jobId}`,
  });
  return g;
}

/**
 * Staff assign a replacement for an offered spot directly: the person is assigned under the usual rules (failing
 * checks need an override reason) and replaces the deputy who offered it.
 */
export async function assignReplacement(
  actor: Actor,
  tx: Tx,
  assignmentId: string,
  userId: string,
  opts: { overrideReason?: string; now?: Date } = {},
): Promise<Assignment> {
  assertCan(actor, "assignment.assign", { vendorId: await assignmentVendorId(tx, assignmentId) });
  const [row] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!row) throw new NotFoundError("Assignment not found.");
  const g = row.status === "signed_up" ? await openOf(tx, assignmentId) : undefined;
  if (!g) throw new ValidationError("There is no open offer on this sign-up.");
  return assignPerson(actor, tx, row.jobPositionId, userId, { overrideReason: opts.overrideReason, notify: true, now: opts.now, replaceGiveawayId: g.id });
}

export type OfferedNotTaken = { assignmentId: string; jobId: string; number: number; title: string; startAt: Date; name: string; offeredAt: Date };

/** Open offers on details that have not started, with who and where, soonest first. `before` limits by start. */
async function openOffersAhead(tx: Tx, now: Date, before?: Date) {
  return tx
    .select({ g: spotGiveaways, a: assignments, job: jobs, name: users.name })
    .from(spotGiveaways)
    .innerJoin(assignments, eq(assignments.id, spotGiveaways.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(eq(spotGiveaways.status, "open"), eq(assignments.status, "signed_up"), inArray(jobs.state, ["scheduled", "active"]), gt(jobs.startAt, now), before ? lte(jobs.startAt, before) : undefined))
    .orderBy(asc(jobs.startAt), asc(spotGiveaways.createdAt));
}

/**
 * To-do: offered spots nobody has taken inside the late cancellation window ("Offered spot not taken"). Nothing is
 * removed automatically; the deputy is still expected to work it.
 */
export async function offeredNotTaken(tx: Tx, now: Date): Promise<OfferedNotTaken[]> {
  const settings = await getSettings(tx);
  const rows = await openOffersAhead(tx, now, new Date(now.getTime() + settings.lateVendorCancelHours * HOUR_MS));
  return rows.map((r) => ({ assignmentId: r.a.id, jobId: r.job.id, number: r.job.number, title: r.job.title, startAt: r.job.startAt, name: r.name, offeredAt: r.g.createdAt }));
}

async function remindDue(tx: Tx, now: Date): Promise<{ reminded: number; ended: number }> {
  const settings = await getSettings(tx);
  // Offers still open when their detail starts end: the deputy works it and bills as normal.
  const started = await tx
    .select({ id: spotGiveaways.id })
    .from(spotGiveaways)
    .innerJoin(assignments, eq(assignments.id, spotGiveaways.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(and(eq(spotGiveaways.status, "open"), lte(jobs.startAt, now)));
  if (started.length) {
    await tx.update(spotGiveaways).set({ status: "ended", endedAt: now }).where(inArray(spotGiveaways.id, started.map((s) => s.id)));
  }
  const due = (await openOffersAhead(tx, now, new Date(now.getTime() + settings.lateVendorCancelHours * HOUR_MS))).filter((r) => r.g.remindedAt === null);
  // Sequential: alert and mark writes in this transaction.
  for (const r of due) {
    await tx.update(spotGiveaways).set({ remindedAt: now }).where(eq(spotGiveaways.id, r.g.id));
    await emit(tx, {
      recipients: [r.a.userId],
      type: "giveaway.reminder",
      title: `Your spot is still yours: #${r.job.number} ${r.job.title}`,
      body: "Nobody has taken over your spot yet. You are still expected to work this detail. Withdraw the offer if you can work it after all.",
      link: `/jobs/${r.job.id}`,
    });
  }
  return { reminded: due.length, ended: started.length };
}

/** Worker tick: reminds deputies whose offered spot is still theirs inside the late window, once each. */
export async function giveawayRemindersTick(now: Date, tx?: Tx): Promise<{ reminded: number; ended: number }> {
  return tx ? remindDue(tx, now) : withTx((t) => remindDue(t, now));
}

export type GiveawayLine = { text: string; at: Date };

const OUTCOME: Record<string, string> = { withdrawn: "Offer withdrawn", canceled: "Offer canceled", ended: "Offer ended" };

/**
 * Each sign-up's offers as staff read them in the sign-up history, oldest first: "Offered by Carmen Caldwell on
 * Dec 1: Family event", then "Taken over by Jordan Example", "Offer withdrawn" or "Offer canceled by Dana Coord".
 */
export async function giveawayHistory(tx: Tx, assignmentIds: string[]): Promise<Map<string, GiveawayLine[]>> {
  const out = new Map<string, GiveawayLine[]>();
  if (assignmentIds.length === 0) return out;
  const rows = await tx
    .select({ g: spotGiveaways, giver: users.name })
    .from(spotGiveaways)
    .innerJoin(assignments, eq(assignments.id, spotGiveaways.assignmentId))
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(inArray(spotGiveaways.assignmentId, assignmentIds))
    .orderBy(asc(spotGiveaways.createdAt), asc(spotGiveaways.id));
  const ids = [...new Set(rows.flatMap((r) => [r.g.endedBy, r.g.takenByAssignmentId]).filter((v): v is string => v !== null))];
  const byUser = new Map((ids.length ? await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids)) : []).map((u) => [u.id, u.name]));
  const takers = new Map(
    (ids.length ? await tx.select({ id: assignments.id, name: users.name }).from(assignments).innerJoin(users, eq(users.id, assignments.userId)).where(inArray(assignments.id, ids)) : []).map((t) => [t.id, t.name]),
  );
  for (const { g, giver } of rows) {
    const lines = out.get(g.assignmentId) ?? [];
    lines.push({ text: `Offered by ${giver} on ${day(g.createdAt)}: ${g.reason}`, at: g.createdAt });
    const outcome = outcomeText(g, takers, byUser);
    if (outcome && g.endedAt) lines.push({ text: outcome, at: g.endedAt });
    out.set(g.assignmentId, lines);
  }
  return out;
}

/** How an offer ended, in words; null while it is open. */
function outcomeText(g: SpotGiveaway, takers: Map<string, string>, byUser: Map<string, string>): string | null {
  if (g.status === "open") return null;
  if (g.status === "taken") return `Taken over by ${takers.get(g.takenByAssignmentId ?? "") ?? "another deputy"}`;
  const by = g.status === "canceled" && g.endedBy ? byUser.get(g.endedBy) : undefined;
  return by ? `Offer canceled by ${by}` : OUTCOME[g.status];
}

/** The sign-ups among these that have an open offer, with when it was made. */
export async function openOffersOf(tx: Tx, assignmentIds: string[]): Promise<Map<string, Date>> {
  if (assignmentIds.length === 0) return new Map();
  const rows = await tx
    .select({ id: spotGiveaways.assignmentId, at: spotGiveaways.createdAt })
    .from(spotGiveaways)
    .where(and(inArray(spotGiveaways.assignmentId, assignmentIds), eq(spotGiveaways.status, "open")));
  return new Map(rows.map((r) => [r.id, r.at]));
}
