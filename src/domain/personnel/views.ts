import { agencyTurnedOff } from "@/domain/notifications/agency";
import type { NotificationType } from "@/domain/notifications/types";
import { and, asc, desc, eq, exists, gt, gte, inArray, isNull, lte, or } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  assignments,
  auditLog,
  invoices,
  jobPositions,
  jobs,
  jobSafety,
  jobSafetyAddresses,
  jobWatches,
  notificationPrefs,
  quietHours,
  paymentIssues,
  paymentMethods,
  positionTypes,
  pushSubscriptions,
  seasons,
  users,
  vendorLocations,
  vendors,
} from "@/db/schema";
import type { Actor } from "../actor";
import { assertCan } from "../auth/policy";
import { canReportNonPayment } from "../payment-issues/issues";
import { responsibleDueAt, type Party } from "../billing/payments";
import { loadUnbilled } from "../billing/lock";
import { seasonFor } from "../caps/seasons";
import type { AssignmentStatus } from "../eligibility/eligibility";
import { canceledWithJob, departureRemovals, suspensionRemovals, type DetailEvent } from "../assignments/history";
import { ForbiddenError } from "../errors";
import { formatInvoiceNumber } from "../invoices/invoices";
import { JOBS_PAGE_SIZE, listJobs, type Job, type JobFilter } from "../jobs/jobs";
import { scheduledPayCents } from "../planning/recommend";
import { scheduleShiftsForCaps } from "../planning/schedule";
import { positionRateCents } from "../jobs/rate";
import { isReleased } from "../release/release";
import { queuedSendFor } from "../invoices/batch";
import { getSettings, type AgencySettings } from "../settings/settings";
import { agencyDateOnly, agencyDateParts, agencyInstant, agencyWeekKey } from "../time/agency-time";
import type { Cents, Minutes } from "../types";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** A canceled or removed assignment stays on the person's own lists this long after the job date. */
const CANCELED_VISIBLE_DAYS = 30;

/** `rateCents` is the position's own hourly rate: the detail's base rate plus its differential. */
type CardPosition = { id: string; name: string; count: number; filled: number; backups: number; rateCents: Cents };

type Availability = "open" | "full" | "not_released" | "started" | "canceled";

/** A job as the personnel lists, map and calendar show it. */
export type JobCard = {
  id: string;
  number: number;
  title: string;
  vendorId: string;
  vendorName: string;
  locationName: string | null;
  address: string | null;
  lat: number | null;
  lng: number | null;
  startAt: Date;
  endAt: Date;
  /** The base rate and its pay; positions with a differential pay up to `maxRateCents` and `maxTotalCents`. */
  rateCents: Cents;
  totalCents: Cents;
  maxRateCents: Cents;
  maxTotalCents: Cents;
  minutes: Minutes;
  flex: { earliestStartAt: Date; latestEndAt: Date; allowShorter: boolean } | null;
  state: Job["state"];
  released: boolean;
  releaseAt: Date | null;
  /** Held by a coordinator: off the open lists, no new sign-ups. */
  held: boolean;
  availability: Availability;
  positions: CardPosition[];
  openSpots: number;
  hasSafety: boolean;
  /** The person's own live assignment status on this job, if any. */
  mine: AssignmentStatus | null;
  watching: boolean;
  typeId: string;
  /** The repeat series the detail belongs to, if any. */
  seriesId: string | null;
};

const LIVE: AssignmentStatus[] = ["pending_short", "signed_up", "backup", "billed", "paid", "late_canceled", "no_show"];

function released(job: Pick<Job, "state" | "held" | "releaseAt">, now: Date): boolean {
  return isReleased(job, now);
}

/** Whether a card can take a sign-up now, and if not, why. */
function cardAvailability(job: Job, now: Date, isReleased: boolean, openSpots: number): Availability {
  if (job.state === "canceled" || job.state === "declined") return "canceled";
  if (now.getTime() >= job.startAt.getTime()) return "started";
  if (!isReleased) return "not_released";
  return openSpots > 0 ? "open" : "full";
}

/**
 * Enriches jobs the actor may already see (from listJobs or a job read) with vendor, location, pay, staffing,
 * safety and the person's own status. Only counts are read about other people.
 */
export async function loadJobCards(actor: Actor, tx: Tx, rows: Job[], now: Date = new Date()): Promise<JobCard[]> {
  assertCan(actor, "job.read");
  if (rows.length === 0) return [];
  const ids = rows.map((j) => j.id);
  const settings = await getSettings(tx);
  const vendorRows = await tx
    .select({ id: vendors.id, name: vendors.name, minimum: vendors.minimumBillableMinutes })
    .from(vendors)
    .where(inArray(vendors.id, [...new Set(rows.map((j) => j.vendorId))]));
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
  const locIds = [...new Set(rows.map((j) => j.locationId).filter((v): v is string => v !== null))];
  const locRows = locIds.length ? await tx.select().from(vendorLocations).where(inArray(vendorLocations.id, locIds)) : [];
  const locById = new Map(locRows.map((l) => [l.id, l]));
  const posRows = await tx
    .select({ id: jobPositions.id, jobId: jobPositions.jobId, count: jobPositions.count, name: positionTypes.name, sort: positionTypes.sortOrder, differential: jobPositions.rateDifferentialCents })
    .from(jobPositions)
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(inArray(jobPositions.jobId, ids))
    .orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const people = await tx
    .select({ jobId: assignments.jobId, positionId: assignments.jobPositionId, status: assignments.status, userId: assignments.userId })
    .from(assignments)
    .where(and(inArray(assignments.jobId, ids), inArray(assignments.status, ["signed_up", "backup", "pending_short", "billed", "paid", "late_canceled", "no_show"])));
  const safetyRows = await tx.select({ jobId: jobSafety.jobId, notes: jobSafety.notes }).from(jobSafety).where(inArray(jobSafety.jobId, ids));
  const addrRows = await tx.select({ jobId: jobSafetyAddresses.jobId }).from(jobSafetyAddresses).where(inArray(jobSafetyAddresses.jobId, ids));
  const safe = new Set([...safetyRows.filter((s) => s.notes?.trim()).map((s) => s.jobId), ...addrRows.map((a) => a.jobId)]);
  const watches = await tx
    .select({ jobId: jobWatches.jobId })
    .from(jobWatches)
    .where(and(eq(jobWatches.userId, actor.userId), inArray(jobWatches.jobId, ids), isNull(jobWatches.endedAt)));
  const watched = new Set(watches.map((w) => w.jobId));

  return rows.map((job) => {
    const vendor = vendorById.get(job.vendorId);
    const loc = job.locationId ? locById.get(job.locationId) : undefined;
    const positions: CardPosition[] = posRows
      .filter((p) => p.jobId === job.id)
      .map((p) => {
        const on = people.filter((a) => a.positionId === p.id);
        return {
          id: p.id,
          name: p.name,
          count: p.count,
          filled: on.filter((a) => a.status !== "backup" && a.status !== "pending_short").length,
          backups: on.filter((a) => a.status === "backup").length,
          rateCents: positionRateCents(job.rateCents, { rateDifferentialCents: p.differential }),
        };
      });
    const openSpots = positions.reduce((n, p) => n + Math.max(0, p.count - p.filled), 0);
    const mineRow = people.find((a) => a.jobId === job.id && a.userId === actor.userId && LIVE.includes(a.status));
    const isReleased = released(job, now);
    const availability = cardAvailability(job, now, isReleased, openSpots);
    const span = { startAt: job.startAt, endAt: job.endAt };
    // A person on the detail sees their own position's pay; everyone else sees the base and the highest position.
    const minePosition = mineRow ? positions.find((p) => p.id === mineRow.positionId) : undefined;
    const rateCents = minePosition?.rateCents ?? job.rateCents;
    const maxRateCents = minePosition ? rateCents : Math.max(job.rateCents, ...positions.map((p) => p.rateCents));
    return {
      id: job.id,
      number: job.number,
      title: job.title,
      vendorId: job.vendorId,
      vendorName: vendor?.name ?? "",
      locationName: loc?.name ?? null,
      address: loc?.address ?? null,
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      startAt: job.startAt,
      endAt: job.endAt,
      rateCents,
      totalCents: scheduledPayCents({ ...job, rateCents }, vendor?.minimum ?? null, settings, span),
      maxRateCents,
      maxTotalCents: scheduledPayCents({ ...job, rateCents: maxRateCents }, vendor?.minimum ?? null, settings, span),
      minutes: Math.round((job.endAt.getTime() - job.startAt.getTime()) / 60_000),
      flex:
        job.flexEarliestStartAt && job.flexLatestEndAt
          ? { earliestStartAt: job.flexEarliestStartAt, latestEndAt: job.flexLatestEndAt, allowShorter: job.flexAllowShorter }
          : null,
      state: job.state,
      released: isReleased,
      releaseAt: job.releaseAt,
      held: job.held,
      availability,
      positions,
      openSpots,
      hasSafety: safe.has(job.id),
      mine: mineRow?.status ?? null,
      watching: watched.has(job.id),
      typeId: job.typeId,
      seriesId: job.seriesId ?? null,
    };
  });
}

export type MyDetail = {
  assignmentId: string;
  status: AssignmentStatus;
  label: string;
  /** Why it was canceled or removed; null otherwise. */
  reason: string | null;
  plannedStartAt: Date;
  plannedEndAt: Date;
  job: JobCard;
};

/**
 * Sign-ups the person is still responsible for working. A spot they offer to give away joins this list when that
 * rule exists: it stays theirs until someone takes it.
 */
export const WORKING_STATUSES: readonly AssignmentStatus[] = ["signed_up", "pending_short"];

/**
 * Home's "Up next" and "On backup": details still ahead that the person works (signed up or pending a shorter
 * shift), and those they wait on as a backup. Canceled, removed and late-canceled sign-ups, and anything on a
 * canceled detail, are history: they stay on Details (My details) and in alerts, never here.
 */
export function upNextAndBackup(mine: MyDetail[], now: Date, limit = 4): { upNext: MyDetail[]; onBackup: MyDetail[] } {
  const ahead = mine.filter((d) => d.job.state !== "canceled" && d.job.state !== "declined" && d.plannedEndAt.getTime() > now.getTime());
  return {
    upNext: ahead.filter((d) => WORKING_STATUSES.includes(d.status)).slice(0, limit),
    onBackup: ahead.filter((d) => d.status === "backup").slice(0, limit),
  };
}

/** What the deputy reads for a sign-up a suspension removed: neutral, the same words as the notice they got. */
const SUSPENSION_REMOVAL_TEXT = "Your sign-up was canceled.";
/** A sign-up ended by a cancel that was later undone: the detail is open again, and the reasons are staff only. */
const BACK_ON_TEXT = "This detail is back on. Sign up again if you still want it.";

const STATUS_LABEL: Record<AssignmentStatus, string> = {
  pending_short: "Pending shorter",
  signed_up: "Signed up",
  backup: "Backup",
  canceled: "Canceled",
  removed: "Removed",
  no_show: "No-show",
  late_canceled: "Late canceled, paid",
  billed: "Billed",
  paid: "Paid",
};

/** The last instant a canceled or removed assignment stays listed: the end of the job's agency day plus 30 days. */
function canceledVisibleUntil(jobStartAt: Date): Date {
  const p = agencyDateParts(jobStartAt);
  return agencyInstant(p.year, p.month, p.day + 1 + CANCELED_VISIBLE_DAYS, 0, 0);
}

/** Why a canceled or removed sign-up ended, as its owner reads it; null while it is live. */
function goneReason(a: typeof assignments.$inferSelect, job: Job, backOn: boolean): string | null {
  if (a.status !== "canceled" && a.status !== "removed") return null;
  if (backOn) return BACK_ON_TEXT;
  if (job.state === "canceled") return job.cancelReason ?? a.removalReason ?? "Detail canceled";
  return a.removalReason ?? (a.status === "canceled" ? "You canceled this sign-up" : "Removed by a coordinator");
}

/**
 * The person's own assignments, soonest first. Canceled and removed ones are listed as such, with the reason,
 * until 30 days after the job date, so a canceled detail does not silently vanish.
 */
export async function myDetails(actor: Actor, tx: Tx, now: Date = new Date(), range: { from?: Date; to?: Date } = {}): Promise<MyDetail[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "job.read");
  const conds = [eq(assignments.userId, actor.userId)];
  if (range.from) conds.push(gte(jobs.startAt, range.from));
  if (range.to) conds.push(lte(jobs.startAt, range.to));
  const rows = await tx
    .select({ a: assignments, job: jobs })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(and(...conds))
    .orderBy(asc(jobs.startAt), asc(assignments.createdAt));
  // A person may have an older canceled row and a newer live one on the same job: keep the live one.
  const live = new Set(rows.filter((r) => r.a.status !== "canceled" && r.a.status !== "removed").map((r) => r.job.id));
  const seen = new Set<string>();
  const kept = rows.filter((r) => {
    const gone = r.a.status === "canceled" || r.a.status === "removed";
    if (gone && (live.has(r.job.id) || now.getTime() >= canceledVisibleUntil(r.job.startAt).getTime())) return false;
    if (seen.has(r.job.id)) return false;
    seen.add(r.job.id);
    return true;
  });
  const cards = new Map((await loadJobCards(actor, tx, kept.map((r) => r.job), now)).map((c) => [c.id, c]));
  // Suspension and leaving the agency are personnel matters: a sign-up either removed reads as a plain cancellation here.
  const neutral = await suspensionRemovals(tx, kept.map((r) => r.a));
  for (const id of await departureRemovals(tx, kept.map((r) => r.a))) neutral.add(id);
  const backOn = await canceledWithJob(tx, kept.filter((r) => r.job.state !== "canceled").map((r) => r.a));
  return kept.map(({ a, job }) => {
    if (neutral.has(a.id)) {
      return { assignmentId: a.id, status: "canceled" as const, label: STATUS_LABEL.canceled, reason: SUSPENSION_REMOVAL_TEXT, plannedStartAt: a.plannedStartAt ?? job.startAt, plannedEndAt: a.plannedEndAt ?? job.endAt, job: cards.get(job.id)! };
    }
    const reason = goneReason(a, job, backOn.has(a.id));
    return {
      assignmentId: a.id,
      status: a.status,
      label: a.status === "backup" && a.backupPosition ? `Backup #${a.backupPosition}` : STATUS_LABEL[a.status],
      reason,
      plannedStartAt: a.plannedStartAt ?? job.startAt,
      plannedEndAt: a.plannedEndAt ?? job.endAt,
      job: cards.get(job.id)!,
    };
  });
}

type Span = [number, number];

function merge(intervals: Array<{ startAt: Date; endAt: Date }>): Span[] {
  const spans = intervals
    .map((i): Span => [i.startAt.getTime(), i.endAt.getTime()])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [s, e] of spans) {
    const last = out.at(-1);
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

const within = (spans: Span[], lo: number, hi: number): Minutes =>
  spans.reduce((n, [s, e]) => n + Math.max(0, Math.round((Math.min(e, hi) - Math.max(s, lo)) / 60_000)), 0);

export type CapUse = { usedMinutes: Minutes; limitMinutes: Minutes | null };
export type CapSummary = { windowHours: number; seasonName: string | null; rolling: CapUse; week: CapUse; month: CapUse };

/**
 * The person's hours against this season's caps: the busiest rolling window from now on, this agency week and
 * this agency month. Held spots and worked details count, as in sign-up checks.
 */
export async function capSummary(actor: Actor, tx: Tx, now: Date = new Date()): Promise<CapSummary> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "job.signup");
  const settings = await getSettings(tx);
  const lo = new Date(now.getTime() - 40 * DAY_MS);
  const hi = new Date(now.getTime() + 40 * DAY_MS);
  const rows = await tx
    .select({ a: assignments, job: jobs })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(
      and(
        eq(assignments.userId, actor.userId),
        inArray(assignments.status, ["pending_short", "signed_up", "billed", "paid"]),
        gte(jobs.startAt, lo),
        lte(jobs.startAt, hi),
      ),
    );
  const intervals = rows.map((r) => ({ startAt: r.a.plannedStartAt ?? r.job.startAt, endAt: r.a.plannedEndAt ?? r.job.endAt }));
  if (settings.capHoursMode === "details_plus_schedule") intervals.push(...(await scheduleShiftsForCaps(tx, actor.userId, lo, hi)));
  const spans = merge(intervals);
  const season = seasonFor(now, await tx.select().from(seasons));

  const windowMs = settings.rollingCapWindowHours * HOUR_MS;
  const t = now.getTime();
  const anchors = [t, ...spans.map(([s]) => s).filter((s) => s + windowMs > t && s < t + 7 * DAY_MS)];
  const rollingUsed = Math.max(0, ...anchors.map((w) => within(spans, Math.max(w, t - windowMs), w + windowMs)));

  const weekStart = agencyDateOnly(agencyWeekKey(now, settings.weekStartsOn as 0 | 1 | 2 | 3 | 4 | 5 | 6))!;
  const wp = agencyDateParts(weekStart);
  const weekEnd = agencyInstant(wp.year, wp.month, wp.day + 7, 0, 0);
  const p = agencyDateParts(now);
  const monthStart = agencyInstant(p.year, p.month, 1, 0, 0);
  const monthEnd = agencyInstant(p.year, p.month + 1, 1, 0, 0);

  return {
    windowHours: settings.rollingCapWindowHours,
    seasonName: season?.name ?? null,
    rolling: { usedMinutes: rollingUsed, limitMinutes: season?.rollingCapMinutes ?? null },
    week: { usedMinutes: within(spans, weekStart.getTime(), weekEnd.getTime()), limitMinutes: season?.weekCapMinutes ?? null },
    month: { usedMinutes: within(spans, monthStart.getTime(), monthEnd.getTime()), limitMinutes: season?.monthCapMinutes ?? null },
  };
}

export type RosterRow = { assignmentId: string; name: string; position: string; status: AssignmentStatus; label: string; startAt: Date; endAt: Date; isYou: boolean };

/** Who holds a spot or a place in line on the job. Names and planned times only; no contact details. */
export async function jobRoster(actor: Actor, tx: Tx, jobId: string): Promise<RosterRow[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "job.read");
  const rows = await tx
    .select({ a: assignments, name: users.name, position: positionTypes.name, jobStart: jobs.startAt, jobEnd: jobs.endAt })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(and(eq(assignments.jobId, jobId), inArray(assignments.status, ["pending_short", "signed_up", "backup", "billed", "paid"])))
    .orderBy(asc(assignments.status), asc(assignments.backupPosition), asc(assignments.requestedAt));
  return rows.map((r) => ({
    assignmentId: r.a.id,
    name: r.name,
    position: r.position,
    status: r.a.status,
    label: r.a.status === "backup" && r.a.backupPosition ? `Backup #${r.a.backupPosition}` : STATUS_LABEL[r.a.status],
    startAt: r.a.plannedStartAt ?? r.jobStart,
    endAt: r.a.plannedEndAt ?? r.jobEnd,
    isYou: r.a.userId === actor.userId,
  }));
}

/** `event`: a cancel or reactivation of the detail, with who and why, for coordinators and admins only. */
export type ActivityRow = { id: string; at: Date; text: string; event?: DetailEvent };

const JOB_EVENTS: Record<string, DetailEvent["kind"]> = { "job.cancel": "canceled", "job.reactivate": "reactivated" };

const JOB_ACTIONS: Record<string, string> = {
  "job.create": "posted the detail",
  "job.update": "changed the detail",
  "job.cancel": "canceled the detail",
  "job.reactivate": "reactivated the detail",
  "job.release_hold": "released the detail",
  "job.safety_update": "updated the officer safety information",
};
const ASSIGNMENT_ACTIONS: Record<string, string> = {
  "assignment.signup": "signed up",
  "assignment.backup_join": "joined the backup list",
  "assignment.cancel": "canceled their sign-up",
  "assignment.assign": "was assigned",
  "assignment.remove": "was removed",
  // Suspension is a personnel matter: other deputies, and the person, see a plain cancellation.
  "assignment.suspension_remove": "had a sign-up canceled",
  // Leaving the agency is a personnel matter too.
  "assignment.departure_remove": "had a sign-up canceled",
  "assignment.claim": "took an opened spot",
  "assignment.short_confirmed": "had a shorter shift confirmed",
  "assignment.short_declined": "had a shorter shift declined",
};
/** The same, in the second person, where it differs: what the person reads about their own sign-up. */
const YOUR_ASSIGNMENT_ACTIONS: Record<string, string> = {
  "assignment.cancel": "canceled your sign-up",
};

/**
 * The job's history from the audit log, newest first, as plain sentences. Reasons and before and after values
 * stay out: personnel see who did what and when, not why someone canceled. Coordinators and admins also get each
 * cancel and reactivation as an `event` with its reason.
 */
export async function jobActivity(actor: Actor, tx: Tx, jobId: string, limit = 30): Promise<ActivityRow[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "job.read");
  const mine = tx.select({ id: assignments.id }).from(assignments).where(eq(assignments.jobId, jobId));
  const rows = await tx
    .select({ id: auditLog.id, at: auditLog.at, action: auditLog.action, entityType: auditLog.entityType, entityId: auditLog.entityId, actorName: users.name, actorId: auditLog.actorUserId, reason: auditLog.reason })
    .from(auditLog)
    .leftJoin(users, eq(users.id, auditLog.actorUserId))
    .where(
      or(
        and(eq(auditLog.entityType, "job"), eq(auditLog.entityId, jobId), inArray(auditLog.action, Object.keys(JOB_ACTIONS))),
        and(eq(auditLog.entityType, "assignment"), inArray(auditLog.entityId, mine), inArray(auditLog.action, Object.keys(ASSIGNMENT_ACTIONS))),
      ),
    )
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(limit);
  // Assignment rows name the person on the assignment (the actor may be a coordinator acting for them).
  const assignmentIds = rows.filter((r) => r.entityType === "assignment" && r.entityId).map((r) => r.entityId!);
  const owners = assignmentIds.length
    ? await tx.select({ id: assignments.id, name: users.name, userId: users.id }).from(assignments).innerJoin(users, eq(users.id, assignments.userId)).where(inArray(assignments.id, assignmentIds))
    : [];
  const ownerById = new Map(owners.map((o) => [o.id, o]));
  const staff = actor.role === "admin" || actor.role === "coordinator";
  // Once a detail is back on, personnel are not told who canceled or reactivated it.
  const [job] = staff ? [] : await tx.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, jobId));
  const anonymous = !staff && job?.state !== "canceled";
  return rows.map((r) => {
    if (r.entityType === "job") {
      const kind = JOB_EVENTS[r.action];
      const text = anonymous && kind ? `The detail was ${kind}` : `${r.actorName ?? "The system"} ${JOB_ACTIONS[r.action]}`;
      return staff && kind ? { id: r.id, at: r.at, text, event: { kind, by: r.actorName, at: r.at, reason: r.reason } } : { id: r.id, at: r.at, text };
    }
    const owner = ownerById.get(r.entityId ?? "");
    const you = owner?.userId === actor.userId;
    let who = "Someone";
    if (owner) who = you ? "You" : owner.name;
    return { id: r.id, at: r.at, text: `${who} ${(you && YOUR_ASSIGNMENT_ACTIONS[r.action]) || ASSIGNMENT_ACTIONS[r.action]}` };
  });
}

export type ToBillItem = {
  assignmentId: string;
  jobId: string;
  jobNumber: number;
  title: string;
  vendorName: string;
  startAt: Date;
  endAt: Date;
  rateCents: Cents;
  totalCents: Cents;
  lateCancel: boolean;
  /** The detail's scheduled end: nothing is billable before it. */
  jobEndAt: Date;
};

/** The person's details waiting for an invoice (worked and ended, or late canceled). */
export async function toBill(actor: Actor, tx: Tx, now: Date = new Date()): Promise<ToBillItem[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "invoice.billOwn", { ownerUserId: actor.userId });
  return billItems(tx, await loadUnbilled(tx, actor.userId, now));
}

/**
 * Another person's details waiting for an invoice, for a coordinator or admin billing on their behalf (someone who
 * left the agency, for one). The usual billing rules apply when the bill is made.
 */
export async function toBillFor(actor: Actor, tx: Tx, ownerUserId: string, now: Date = new Date()): Promise<ToBillItem[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "invoice.billOwn", { ownerUserId });
  return billItems(tx, await loadUnbilled(tx, ownerUserId, now));
}

/**
 * The person's late cancellations whose detail has not reached its scheduled end: listed on the billing screen
 * but not billable yet, and not counted anywhere until the end passes.
 */
export async function upcomingLateCancels(actor: Actor, tx: Tx, now: Date = new Date()): Promise<ToBillItem[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "invoice.billOwn", { ownerUserId: actor.userId });
  const rows = await tx
    .select({ assignmentId: assignments.id })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(and(eq(assignments.userId, actor.userId), eq(assignments.status, "late_canceled"), gt(jobs.endAt, now)))
    .orderBy(asc(jobs.endAt), asc(assignments.id));
  return billItems(tx, rows);
}

async function billItems(tx: Tx, items: Array<{ assignmentId: string }>): Promise<ToBillItem[]> {
  if (items.length === 0) return [];
  const settings = await getSettings(tx);
  const rows = await tx
    .select({ a: assignments, job: jobs, vendorName: vendors.name, vendorMin: vendors.minimumBillableMinutes, differential: jobPositions.rateDifferentialCents })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(inArray(assignments.id, items.map((i) => i.assignmentId)));
  const byId = new Map(rows.map((r) => [r.a.id, r]));
  return items.map((i) => {
    const r = byId.get(i.assignmentId)!;
    const startAt = r.a.plannedStartAt ?? r.job.startAt;
    const endAt = r.a.plannedEndAt ?? r.job.endAt;
    return {
      assignmentId: i.assignmentId,
      jobId: r.job.id,
      jobNumber: r.job.number,
      title: r.job.title,
      vendorName: r.vendorName,
      startAt,
      endAt,
      rateCents: positionRateCents(r.job.rateCents, { rateDifferentialCents: r.differential }),
      totalCents: scheduledPayCents({ ...r.job, rateCents: positionRateCents(r.job.rateCents, { rateDifferentialCents: r.differential }) }, r.vendorMin, settings, { startAt, endAt }),
      lateCancel: r.a.status === "late_canceled",
      jobEndAt: r.job.endAt,
    };
  });
}

type Turn = "deputy" | "vendor" | "coordinator" | null;

export type MyInvoice = {
  id: string;
  number: string;
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  vendorName: string;
  jobStartAt: Date;
  minutes: Minutes;
  rateCents: Cents;
  totalCents: Cents;
  status: (typeof invoices.$inferSelect)["status"];
  sentAt: Date | null;
  deputyPaidAt: Date | null;
  vendorPaidAt: Date | null;
  vendorMethod: string | null;
  vendorReference: string | null;
  turn: Turn;
  dueAt: Date | null;
  responseDays: number | null;
  openIssue: boolean;
  canReport: boolean;
  closedReason: string | null;
  /** On a queued invoice: "Queued for the weekly send on Fri, Nov 27." */
  queuedSend: string | null;
};

function turnInfo(inv: typeof invoices.$inferSelect, settings: AgencySettings): { turn: Turn; dueAt: Date | null; responseDays: number | null } {
  const party = inv.responsibleParty as Party | null;
  if (!party || !inv.responsibleSince || inv.status !== "sent") return { turn: null, dueAt: null, responseDays: null };
  return { turn: party, dueAt: responsibleDueAt(party, inv.responsibleSince, settings), responseDays: settings.responseDays[party] };
}

/** The person's own invoices, newest job first, with whose turn it is and whether non-payment can be reported. */
export async function myInvoices(actor: Actor, tx: Tx, now: Date = new Date(), only?: string): Promise<MyInvoice[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "earnings.read", { ownerUserId: actor.userId });
  const settings = await getSettings(tx);
  const openIssue = exists(tx.select({ x: paymentIssues.id }).from(paymentIssues).where(and(eq(paymentIssues.invoiceId, invoices.id), eq(paymentIssues.status, "open"))));
  const conds = [eq(invoices.payeeUserId, actor.userId)];
  if (only) conds.push(eq(invoices.id, only));
  const rows = await tx
    .select({ inv: invoices, job: jobs, vendorName: vendors.name, vendorSchedule: vendors.invoiceSendSchedule, method: paymentMethods.name, openIssue })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .leftJoin(paymentMethods, eq(paymentMethods.id, invoices.vendorPaidMethodId))
    .where(and(...conds))
    .orderBy(desc(jobs.startAt), desc(invoices.number));
  return rows.map(({ inv, job, vendorName, vendorSchedule, method, openIssue: issue }) => {
    const hasIssue = Boolean(issue);
    return {
      id: inv.id,
      number: formatInvoiceNumber(settings.invoiceNumberPrefix, inv.number),
      jobId: job.id,
      jobNumber: job.number,
      jobTitle: job.title,
      vendorName,
      jobStartAt: job.startAt,
      minutes: inv.minutes,
      rateCents: inv.rateCents,
      totalCents: inv.totalCents,
      status: inv.status,
      sentAt: inv.sentAt,
      deputyPaidAt: inv.deputyPaidAt,
      vendorPaidAt: inv.vendorPaidAt,
      vendorMethod: method,
      vendorReference: inv.vendorPaidReference,
      ...turnInfo(inv, settings),
      openIssue: hasIssue,
      canReport: canReportNonPayment({ ...inv, hasOpenIssue: hasIssue }, now, settings),
      closedReason: inv.closedReason,
      queuedSend: queuedSendFor(inv, vendorSchedule, settings, now),
    };
  });
}

/** Payment methods to choose from when recording a payment. */
export async function activePaymentMethods(tx: Tx): Promise<Array<{ id: string; name: string }>> {
  return tx.select({ id: paymentMethods.id, name: paymentMethods.name }).from(paymentMethods).where(eq(paymentMethods.active, true)).orderBy(asc(paymentMethods.sortOrder), asc(paymentMethods.name));
}

/** Active people who can be messaged (never vendors), by name, with their rank. */
export async function messageDirectory(actor: Actor, tx: Tx): Promise<Array<{ id: string; name: string; rankId: string | null }>> {
  assertCan(actor, "message.send");
  return tx
    .select({ id: users.id, name: users.name, rankId: users.rankId })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, ["personnel", "coordinator", "admin"])))
    .orderBy(asc(users.name));
}

export type AlertSettings = {
  prefs: Record<string, { email: boolean; push: boolean }>;
  quietHours: { enabled: boolean; start: string; end: string };
  pushDevices: number;
  /** Channels the agency turned off for the person's group, per type (true = off). Types with nothing off are absent. */
  agencyOff: Partial<Record<NotificationType, { email: boolean; push: boolean }>>;
};

/** The person's own alert choices (types without a row default to email and push on) and quiet hours. */
export async function alertSettings(actor: Actor, tx: Tx): Promise<AlertSettings> {
  assertCan(actor, "profile.updateOwn", { ownerUserId: actor.userId });
  const rows = await tx.select().from(notificationPrefs).where(eq(notificationPrefs.userId, actor.userId));
  const [q] = await tx.select().from(quietHours).where(eq(quietHours.userId, actor.userId));
  const devices = await tx.select({ id: pushSubscriptions.id }).from(pushSubscriptions).where(eq(pushSubscriptions.userId, actor.userId));
  return {
    prefs: Object.fromEntries(rows.map((r) => [r.type, { email: r.email, push: r.push }])),
    quietHours: { enabled: q?.enabled ?? false, start: q?.startTime ?? "22:00", end: q?.endTime ?? "07:00" },
    pushDevices: devices.length,
    agencyOff: await agencyTurnedOff(tx, actor.role),
  };
}

/** Upper bound on pages read by `listAllJobs`, so a runaway window cannot load the whole table. */
const MAX_LIST_PAGES = 40;

/**
 * Every job `listJobs` returns for the filter, reading page after page (nothing is silently dropped at the
 * page size). Stops at MAX_LIST_PAGES pages and reports whether it did.
 */
export async function listAllJobs(actor: Actor, tx: Tx, filter: JobFilter): Promise<{ jobs: Job[]; truncated: boolean }> {
  const out: Job[] = [];
  // Sequential: reads stop at the first short page, in this transaction.
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const rows = await listJobs(actor, tx, filter, page);
    out.push(...rows);
    if (rows.length < JOBS_PAGE_SIZE) return { jobs: out, truncated: false };
  }
  return { jobs: out, truncated: true };
}
