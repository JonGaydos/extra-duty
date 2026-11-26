import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { auditLog, users } from "@/db/schema";

/** The audit action written when a person cancels their own sign-up (cancelSignup): "gave away" the spot. */
export const GAVE_AWAY_ACTION = "assignment.cancel";

/** The audit action written for each sign-up a job cancel ended (cancelJobUnchecked). */
const JOB_CANCELED_ACTION = "assignment.job_canceled";

/** The audit action written for late-cancel pay a reactivation cancels (reactivateJob): the late cancel did not happen. */
export const LATE_CANCEL_VOID_ACTION = "assignment.late_cancel_void";

/** The audit action written when a suspension removes the person's future sign-ups (suspendUser). */
export const SUSPENSION_REMOVE_ACTION = "assignment.suspension_remove";
/** The removal reason a suspension stores on the row. Before SUSPENSION_REMOVE_ACTION existed, a suspension wrote
 * assignment.remove with this on the row and an audit reason starting "Suspended: "; such rows are suspension
 * removals too. A coordinator removal stores the same comment on both, so it can never match both. */
export const SUSPENSION_REMOVAL_REASON = "Suspended";
const LEGACY_SUSPENSION_AUDIT_REASON = `${SUSPENSION_REMOVAL_REASON}: %`;
const REMOVED_BY_SUSPENSION = "Removed by suspension";

/** The audit action written when someone leaves the agency and their sign-ups after the last day go (deactivateUser). */
export const DEPARTURE_REMOVE_ACTION = "assignment.departure_remove";
/** The removal reason a departure stores on the row, and the label staff read. Nobody else is told why. */
export const LEFT_THE_AGENCY = "Left the agency";

/** Audit actions that end a sign-up, and the label each one shows on a detail's deputy list. */
const ENDING: Record<string, string> = {
  [GAVE_AWAY_ACTION]: "Gave away",
  "assignment.remove": "Removed by coordinator",
  [SUSPENSION_REMOVE_ACTION]: REMOVED_BY_SUSPENSION,
  [DEPARTURE_REMOVE_ACTION]: LEFT_THE_AGENCY,
  "assignment.no_show": "No-show",
  "assignment.late_cancel": "Vendor canceled late",
  [JOB_CANCELED_ACTION]: "Canceled",
  [LATE_CANCEL_VOID_ACTION]: "Late-cancel pay canceled",
  "assignment.short_declined": "Canceled",
};

/** A row's label when no ending is on record (rows written before audit, or by a path that does not audit). */
const STATUS_LABEL: Record<string, string> = {
  pending_short: "Shorter shift, pending",
  signed_up: "Signed up",
  backup: "Backup",
  canceled: "Canceled",
  removed: "Removed by coordinator",
  no_show: "No-show",
  late_canceled: "Vendor canceled late",
  billed: "Billed",
  paid: "Paid",
};

/** Rows that no longer hold a spot or a place in line. */
const ENDED_STATUSES: readonly string[] = ["canceled", "removed", "no_show", "late_canceled"];

/**
 * Which of these removed rows a suspension removed: by its audit action, or (older rows) by the suspension's marker
 * on both the row and its assignment.remove audit reason. Suspension is a personnel matter: only coordinators and
 * admins may see the result as such; everyone else sees a plain cancellation.
 */
export async function suspensionRemovals(tx: Tx, rows: Array<{ id: string; status: string; removalReason: string | null }>): Promise<Set<string>> {
  const removed = rows.filter((r) => r.status === "removed");
  if (removed.length === 0) return new Set();
  const marked = new Set(removed.filter((r) => r.removalReason === SUSPENSION_REMOVAL_REASON).map((r) => r.id));
  const hits = await tx
    .select({ id: auditLog.entityId, action: auditLog.action })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.entityType, "assignment"),
        inArray(auditLog.entityId, removed.map((r) => r.id)),
        or(eq(auditLog.action, SUSPENSION_REMOVE_ACTION), and(eq(auditLog.action, "assignment.remove"), like(auditLog.reason, LEGACY_SUSPENSION_AUDIT_REASON))),
      ),
    );
  return new Set(hits.filter((h) => h.id && (h.action === SUSPENSION_REMOVE_ACTION || marked.has(h.id))).map((h) => h.id!));
}

/** Which of these removed rows a departure removed. Staff only may see them as such; everyone else sees a plain cancellation. */
export async function departureRemovals(tx: Tx, rows: Array<{ id: string; status: string }>): Promise<Set<string>> {
  const removed = rows.filter((r) => r.status === "removed");
  if (removed.length === 0) return new Set();
  const hits = await tx
    .select({ id: auditLog.entityId })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "assignment"), eq(auditLog.action, DEPARTURE_REMOVE_ACTION), inArray(auditLog.entityId, removed.map((r) => r.id))));
  return new Set(hits.map((h) => h.id!));
}

/** Which of these canceled rows ended because the whole detail was canceled (or its late-cancel pay went with a reactivation). */
export async function canceledWithJob(tx: Tx, rows: Array<{ id: string; status: string }>): Promise<Set<string>> {
  const canceled = rows.filter((r) => r.status === "canceled");
  if (canceled.length === 0) return new Set();
  const hits = await tx
    .select({ id: auditLog.entityId })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "assignment"), inArray(auditLog.action, [JOB_CANCELED_ACTION, LATE_CANCEL_VOID_ACTION]), inArray(auditLog.entityId, canceled.map((r) => r.id))));
  return new Set(hits.map((h) => h.id!));
}

type Ending = { by: string | null; at: Date; reason: string | null };
export type HistoryEntry = { label: string; active: boolean; ended: Ending | null };

/**
 * How each sign-up on a detail ended: the label, who did it, when and the reason, read from the audit log in one
 * query. Staff only; callers must have checked that the actor may see removal reasons.
 */
export async function signupHistory(tx: Tx, rows: Array<{ id: string; status: string; updatedAt: Date; removalReason: string | null }>): Promise<Map<string, HistoryEntry>> {
  const ended = rows.filter((r) => ENDED_STATUSES.includes(r.status));
  const events = ended.length
    ? await tx
        .select({ entityId: auditLog.entityId, action: auditLog.action, at: auditLog.at, reason: auditLog.reason, by: users.name })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(and(eq(auditLog.entityType, "assignment"), inArray(auditLog.entityId, ended.map((r) => r.id)), inArray(auditLog.action, Object.keys(ENDING))))
        .orderBy(desc(auditLog.at), desc(auditLog.id))
    : [];
  const latest = new Map<string, (typeof events)[number]>();
  for (const e of events) if (e.entityId && !latest.has(e.entityId)) latest.set(e.entityId, e);
  const bySuspension = await suspensionRemovals(tx, ended);
  return new Map(
    rows.map((r) => {
      const active = !ENDED_STATUSES.includes(r.status);
      const e = active ? undefined : latest.get(r.id);
      let label: string;
      if (bySuspension.has(r.id)) label = REMOVED_BY_SUSPENSION;
      else label = e ? ENDING[e.action] : (STATUS_LABEL[r.status] ?? r.status);
      // Without an audit row, fall back to when the row last changed and the reason stored on it.
      let ending: Ending | null = null;
      if (!active) ending = e ? { by: e.by, at: e.at, reason: e.reason } : { by: null, at: r.updatedAt, reason: r.removalReason };
      return [r.id, { label, active, ended: ending }];
    }),
  );
}

/** A cancel or reactivation of the whole detail: who, when and why. Staff only. */
export type DetailEvent = { kind: "canceled" | "reactivated"; by: string | null; at: Date; reason: string | null };

const DETAIL_EVENTS: Record<string, DetailEvent["kind"]> = { "job.cancel": "canceled", "job.reactivate": "reactivated" };

/** Every cancel and reactivation of a detail, oldest first. Staff only; callers must have checked the actor. */
export async function detailEvents(tx: Tx, jobId: string): Promise<DetailEvent[]> {
  const rows = await tx
    .select({ action: auditLog.action, at: auditLog.at, reason: auditLog.reason, by: users.name })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(and(eq(auditLog.entityType, "job"), eq(auditLog.entityId, jobId), inArray(auditLog.action, Object.keys(DETAIL_EVENTS))))
    .orderBy(asc(auditLog.at), asc(auditLog.id));
  return rows.map((r) => ({ kind: DETAIL_EVENTS[r.action], by: r.by, at: r.at, reason: r.reason }));
}
