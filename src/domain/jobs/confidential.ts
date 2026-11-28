import { and, desc, eq, inArray, isNull, or, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, auditLog, jobPositions, jobs, jobWatches, spotGiveaways, users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { releaseAt } from "../release/release";
import { getSettings } from "../settings/settings";
import { AGENCY_TZ } from "../time/agency-time";

/**
 * Confidential details (owner decision 2026-11-27), for example VIP or dignitary protection. Only coordinators, admins
 * and the people assigned to one see it; for everyone else it does not exist (lists, search, alerts, the API and its
 * number all answer as for a detail that is not there). It is never open for sign-up or released: people are added
 * only by staff assignment.
 */

/** What a confidential detail is called wherever its title would leave the app (email, push, calendar feeds, tax summaries). */
export const CONFIDENTIAL_TITLE = "Confidential detail";

/** Assignment statuses that count as being assigned: on the detail now, or worked, billed or paid for it. */
export const ASSIGNED_STATUSES = ["pending_short", "signed_up", "billed", "paid", "late_canceled", "no_show"] as const;

/** Coordinators and admins see every confidential detail. */
export function seesAllConfidential(actor: Pick<Actor, "role">): boolean {
  return actor.role === "coordinator" || actor.role === "admin";
}

/**
 * The jobs rows the actor may see as far as confidentiality goes, for any query on `jobs`; undefined for staff.
 * Vendors and vendor managers never see one unless they are assigned to it.
 */
export function confidentialVisible(tx: Tx, actor: Actor): SQL | undefined {
  if (seesAllConfidential(actor)) return undefined;
  if (actor.role === "vendor") return eq(jobs.confidential, false);
  const assigned = tx
    .select({ jobId: assignments.jobId })
    .from(assignments)
    .where(and(eq(assignments.userId, actor.userId), inArray(assignments.status, [...ASSIGNED_STATUSES])));
  return or(eq(jobs.confidential, false), inArray(jobs.id, assigned));
}

/** Whether the person is assigned to the detail (see ASSIGNED_STATUSES). */
export async function isAssigned(tx: Tx, userId: string, jobId: string): Promise<boolean> {
  const rows = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobId, jobId), eq(assignments.userId, userId), inArray(assignments.status, [...ASSIGNED_STATUSES])))
    .limit(1);
  return rows.length > 0;
}

/** Whether the actor may see this detail as far as confidentiality goes. */
export async function maySeeJob(tx: Tx, actor: Actor, job: { id: string; confidential: boolean }): Promise<boolean> {
  if (!job.confidential || seesAllConfidential(actor)) return true;
  if (actor.role === "vendor") return false;
  return isAssigned(tx, actor.userId, job.id);
}

/** Refuses a confidential detail the actor may not see with the same answer as a detail that does not exist. */
export async function assertMaySeeJob(tx: Tx, actor: Actor, job: { id: string; confidential: boolean }): Promise<void> {
  if (!(await maySeeJob(tx, actor, job))) throw new NotFoundError("Job not found.");
}

/** By id: false for a missing detail too. */
export async function maySeeJobId(tx: Tx, actor: Actor, jobId: string): Promise<boolean> {
  const [job] = await tx.select({ id: jobs.id, confidential: jobs.confidential }).from(jobs).where(eq(jobs.id, jobId));
  return !!job && (await maySeeJob(tx, actor, job));
}

const VIEW_ACTION = "job.confidential_view";

/** Logs one open of a confidential detail (who and when), whoever opens it, so staff can review access. */
export async function recordConfidentialView(tx: Tx, actor: Actor, job: { id: string; confidential: boolean }): Promise<void> {
  if (!job.confidential) return;
  await recordAudit(tx, { actor, action: VIEW_ACTION, entityType: "job", entityId: job.id });
}

export type ConfidentialView = { id: string; name: string | null; at: Date };

/** Who opened a confidential detail and when, newest first. Coordinators and admins. */
export async function confidentialViews(actor: Actor, tx: Tx, jobId: string, limit = 100): Promise<ConfidentialView[]> {
  if (!seesAllConfidential(actor)) throw new ForbiddenError();
  return tx
    .select({ id: auditLog.id, name: users.name, at: auditLog.at })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.action, VIEW_ACTION), eq(auditLog.entityType, "job"), eq(auditLog.entityId, jobId)))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);
}

/** The reason for turning Confidential on or off: required, at most 500 characters. */
export function confidentialReason(reason: string | null | undefined): string {
  const why = reason?.trim() ?? "";
  if (!why) throw new ValidationError("Give a reason for changing Confidential.");
  if (why.length > 500) throw new ValidationError("The reason can be at most 500 characters.");
  return why;
}

/** The job columns of a confidential detail: never held and never released. */
export const CONFIDENTIAL_FIELDS = { confidential: true, held: false, releaseAt: null } as const;

/** The job columns of a detail that stops being confidential: it releases on the agency schedule. */
export function openedFields(startAt: Date, settings: Parameters<typeof releaseAt>[1]): { confidential: false; held: false; releaseAt: Date } {
  return { confidential: false, held: false, releaseAt: releaseAt(startAt, settings) };
}

/** Audits a change of Confidential (on create too), with its reason. */
export async function auditConfidential(tx: Tx, actor: Actor, jobId: string, before: boolean | null, on: boolean, reason: string): Promise<void> {
  await recordAudit(tx, { actor, action: on ? "job.confidential_on" : "job.confidential_off", entityType: "job", entityId: jobId, before: before === null ? null : { confidential: before }, after: { confidential: on }, reason });
}

/**
 * Turns Confidential on or off, with a reason; coordinators and admins only, audited. On: the detail leaves every
 * list for anyone not assigned, its backups and watches end (there is no sign-up), and it is no longer held or
 * released. Off: it releases on the agency schedule like any other detail.
 */
export async function setConfidential(actor: Actor, tx: Tx, jobId: string, on: boolean, reason: string, now: Date = new Date()): Promise<typeof jobs.$inferSelect> {
  assertCan(actor, "job.confidential");
  const why = confidentialReason(reason);
  const [before] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!before) throw new NotFoundError("Job not found.");
  if (before.confidential === on) throw new ValidationError(on ? "This detail is already confidential." : "This detail is not confidential.");
  if (before.state === "requested" || before.state === "declined") throw new ValidationError("Approve the vendor request first.");
  const settings = await getSettings(tx);
  const fields = on ? CONFIDENTIAL_FIELDS : openedFields(before.startAt, settings);
  const [after] = await tx.update(jobs).set({ ...fields, updatedAt: now }).where(eq(jobs.id, jobId)).returning();
  if (on) {
    // Nobody waits for a spot on a confidential detail: its backups and watches end.
    const backups = await tx.update(assignments).set({ status: "removed", updatedAt: now }).where(and(eq(assignments.jobId, jobId), eq(assignments.status, "backup"))).returning({ id: assignments.id });
    await tx.update(jobWatches).set({ endedAt: now }).where(and(eq(jobWatches.jobId, jobId), isNull(jobWatches.endedAt)));
    if (backups.length) await recordAudit(tx, { actor, action: "job.confidential_backups_removed", entityType: "job", entityId: jobId, after: { assignmentIds: backups.map((b) => b.id) } });
    // A confidential spot is never offered to others: open offers end, and their deputies keep the spots.
    const offers = await tx
      .update(spotGiveaways)
      .set({ status: "canceled", endedAt: now, endedBy: actor.userId })
      .where(and(eq(spotGiveaways.status, "open"), inArray(spotGiveaways.jobPositionId, tx.select({ id: jobPositions.id }).from(jobPositions).where(eq(jobPositions.jobId, jobId)))))
      .returning({ id: spotGiveaways.id });
    if (offers.length) await recordAudit(tx, { actor, action: "job.confidential_offers_canceled", entityType: "job", entityId: jobId, after: { giveawayIds: offers.map((o) => o.id) } });
  }
  await auditConfidential(tx, actor, jobId, before.confidential, on, why);
  return after;
}

/** "Dec 4, 2026": the agency date of a detail, the only fact an email or push about a confidential detail carries. */
export function confidentialDate(startAt: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, dateStyle: "medium" }).format(startAt);
}

/** The start time of a confidential detail in agency time, such as 5:00 PM: with the date, all its email and push say. */
export function confidentialTime(startAt: Date): string {
  return new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, hour: "numeric", minute: "2-digit" }).format(startAt);
}
