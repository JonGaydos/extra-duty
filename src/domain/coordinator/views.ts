import { and, asc, desc, eq, gt, inArray, isNull, lte, ne, notInArray, or, sql } from "drizzle-orm";
import { departedUnbilled, type DepartureUnbilled } from "../users/departure";
import type { Tx } from "@/db/client";
import {
  accessReviewItems,
  assignments,
  deputyNotes,
  invoiceEvents,
  invoices,
  jobChangeRequests,
  jobPositions,
  jobTypes,
  jobs,
  opsPlanVersions,
  opsPlans,
  paymentIssues,
  positionTypes,
  qualificationRequests,
  qualifications,
  users,
  vendorDocuments,
  vendorHolds,
  vendorContacts,
  vendorLocations,
  vendorRestrictions,
  vendorTypes,
  vendors,
  vendorUsers,
} from "@/db/schema";
import type { Actor } from "../actor";
import { detailEvents, signupHistory, type DetailEvent, type HistoryEntry } from "../assignments/history";
import { assertCan } from "../auth/policy";
import { lockedPeople } from "../billing/lock";
import { isOverdue, responsibleDueAt, type Party } from "../billing/payments";
import { NotFoundError } from "../errors";
import { formatInvoiceNumber } from "../invoices/invoices";
import { dueInvoiceBatches, queuedSendFor, type VendorBatch } from "../invoices/batch";
import { listInvoicesForReview, sendableLater, type ReviewRow } from "../invoices/review";
import { effectiveSchedule, type SendSchedule } from "../invoices/send-schedule";
import { upcomingMissingContract } from "../jobs/contract-status";
import { opsPlanDueAt } from "../ops-plans/ops-plans";
import { scheduledPayCents } from "../planning/recommend";
import { getSettings, type AgencySettings as AgencySettingsLike } from "../settings/settings";
import { currentW9 } from "../w9/w9";
import { findOpenReview } from "../users/access-review";
import { lockedDetailsForTodo } from "../vendor-portal/holds";
import { releaseAt } from "../release/release";
import { positionRateCents } from "../jobs/rate";
import { agencyDateParts, agencyInstant } from "../time/agency-time";
import type { Cents } from "../types";

/**
 * Read models for the coordinator screens. Each one asserts a coordinator-level policy action; everything they
 * return is already visible to coordinators and admins. Nothing here reads a deputy's private planning data
 * (work schedule, calendar, hidden vendors).
 */

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

const isStaff = (a: Actor) => a.role === "coordinator" || a.role === "admin";

type LockedRow = { jobId: string; number: number; title: string; vendorName: string; startAt: Date; endAt: Date; holdPlacedAt: Date; signedUp: number; latePay: boolean };
type RequestRow = { jobId: string; title: string; vendorName: string; locationName: string | null; startAt: Date; endAt: Date; dates: number; positions: string; flex: { earliestStartAt: Date; latestEndAt: Date } | null };
type ChangeRow = { requestId: string; jobId: string; title: string; vendorName: string; requestedAt: Date };
type NoteRow = { id: string; body: string; vendorName: string; locationName: string | null; authorName: string; submittedAt: Date };
type FlagRequestRow = { id: string; userName: string; qualificationName: string; note: string | null; requestedAt: Date };
type MissingContractRow = { jobId: string; number: number; title: string; vendorId: string; vendorName: string; startAt: Date };
type IssueRow = { issueId: string; invoiceId: string; number: string; vendorName: string; payeeName: string; totalCents: Cents; since: Date; day: number; limitDays: number };
export type OpsRow = { jobId: string; opsPlanId: string | null; title: string; vendorName: string; startAt: Date; dueAt: Date | null; icName: string | null; version: number; waitingSince: Date | null; canReview: boolean; versionId: string | null };
type UnfilledRow = { jobId: string; title: string; vendorName: string; startAt: Date; open: number };
type LockRow = { userId: string; name: string; unbilled: number; unacknowledged: number };

export type CoordinatorTodo = {
  accessReview: { reviewId: string; decided: number; total: number; dueAt: Date } | null;
  lockedStarted: LockedRow[];
  lockedSoon: LockedRow[];
  requests: RequestRow[];
  changes: ChangeRow[];
  notes: NoteRow[];
  flagRequests: FlagRequestRow[];
  missingContract: MissingContractRow[];
  /** `batched`: approving queues it for the vendor's next send instead of emailing it now. */
  invoices: Array<ReviewRow & { formattedNumber: string; scheduledMinutes: number; batched: boolean; /** The vendor's default: Approve and send (true) or Approve, don't send. */ sendByDefault: boolean }>;
  issues: IssueRow[];
  opsOverdue: OpsRow[];
  opsWaiting: OpsRow[];
  unfilled: UnfilledRow[];
  locks: LockRow[];
  /** Upcoming details whose rate is outside the agency range and was never approved as an exception. */
  ratesOutOfRange: RateRow[];
  /** Vendor invoice batches whose send day has come. */
  sendInvoices: VendorBatch[];
  /** Worked details of people who left the agency, still to bill for them or write off. */
  departed: Array<DepartureUnbilled & { name: string }>;
};

export type RateRow = { jobId: string; title: string; vendorName: string; startAt: Date; rateCents: Cents };

/** Upcoming details outside the agency rate range, without an approved override, soonest first. */
export async function ratesOutsideRange(tx: Tx, settings: Pick<AgencySettingsLike, "rateMinCents" | "rateMaxCents">, now: Date): Promise<RateRow[]> {
  const { rateMinCents: min, rateMaxCents: max } = settings;
  if (min === null && max === null) return [];
  const outside = or(min !== null ? sql`${jobs.rateCents} < ${min}` : undefined, max !== null ? sql`${jobs.rateCents} > ${max}` : undefined);
  return tx
    .select({ jobId: jobs.id, title: jobs.title, vendorName: vendors.name, startAt: jobs.startAt, rateCents: jobs.rateCents })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(and(gt(jobs.startAt, now), inArray(jobs.state, ["requested", "scheduled", "active"]), isNull(jobs.rateOverrideReason), outside))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
}

async function signedUpCounts(tx: Tx, jobIds: string[]): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  const rows = await tx
    .select({ jobId: assignments.jobId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(inArray(assignments.jobId, jobIds), eq(assignments.status, "signed_up")))
    .groupBy(assignments.jobId);
  return new Map(rows.map((r) => [r.jobId, r.n]));
}

/** Statuses that hold a spot: the same list the detail page's staffing grid counts as filled. */
const HOLDING_STATUSES = ["signed_up", "pending_short", "billed", "paid", "no_show"] as const;

async function holdingCounts(tx: Tx, jobIds: string[]): Promise<Map<string, number>> {
  if (jobIds.length === 0) return new Map();
  const rows = await tx
    .select({ jobId: assignments.jobId, n: sql<number>`count(*)::int` })
    .from(assignments)
    .where(and(inArray(assignments.jobId, jobIds), inArray(assignments.status, [...HOLDING_STATUSES])))
    .groupBy(assignments.jobId);
  return new Map(rows.map((r) => [r.jobId, r.n]));
}

/** Whole days since `since` (at least 1). */
/** Whole days something has waited, at least 1 ("Day 3 of 7"). */
export const daysWaiting = (since: Date, now: Date) => Math.max(1, Math.floor((now.getTime() - since.getTime()) / DAY_MS));

async function positionSummary(tx: Tx, jobIds: string[]): Promise<Map<string, string>> {
  if (jobIds.length === 0) return new Map();
  const rows = await tx
    .select({ jobId: jobPositions.jobId, name: positionTypes.name, count: jobPositions.count })
    .from(jobPositions)
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(inArray(jobPositions.jobId, jobIds))
    .orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const out = new Map<string, string[]>();
  for (const r of rows) out.set(r.jobId, [...(out.get(r.jobId) ?? []), `${r.name} ${r.count}`]);
  return new Map([...out].map(([k, v]) => [k, v.join(", ")]));
}

/** Plans that need a coordinator: overdue (no plan in, past due, detail not over) and versions waiting for review. */
export async function opsPlanQueue(actor: Actor, tx: Tx, now: Date = new Date()): Promise<{ overdue: OpsRow[]; waiting: OpsRow[] }> {
  assertCan(actor, "job.update");
  const settings = await getSettings(tx);
  const rows = await tx
    .select({ job: jobs, vendorName: vendors.name, plan: opsPlans })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .leftJoin(opsPlans, eq(opsPlans.jobId, jobs.id))
    .where(and(eq(jobs.opsPlanRequired, true), inArray(jobs.state, ["scheduled", "active"]), gt(jobs.endAt, now)))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
  const overdue: OpsRow[] = [];
  const waiting: OpsRow[] = [];
  if (rows.length === 0) return { overdue, waiting };
  // Incident Commanders for every job at once, by the same rule as currentIcInfo: the earliest signed-up person in
  // an IC position, else the earliest roster member a coordinator named.
  const icRows = await tx
    .select({ jobId: assignments.jobId, userId: assignments.userId, name: users.name, createdAt: assignments.createdAt, icAssignedAt: assignments.icAssignedAt, icPosition: positionTypes.isIncidentCommander, named: assignments.isIncidentCommander, id: assignments.id })
    .from(assignments)
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(inArray(assignments.jobId, rows.map((r) => r.job.id)), eq(assignments.status, "signed_up"), or(eq(positionTypes.isIncidentCommander, true), eq(assignments.isIncidentCommander, true))))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
  const icOf = (jobId: string) => icRows.find((r) => r.jobId === jobId && r.icPosition) ?? icRows.find((r) => r.jobId === jobId && r.named) ?? null;
  const planIds = rows.flatMap((r) => (r.plan ? [r.plan.id] : []));
  const versions = planIds.length
    ? await tx.select().from(opsPlanVersions).where(inArray(opsPlanVersions.opsPlanId, planIds)).orderBy(desc(opsPlanVersions.submittedAt), desc(opsPlanVersions.id))
    : [];
  const reviewer = settings.opsPlanReviewerUserIds.includes(actor.userId);
  for (const { job, vendorName, plan } of rows) {
    const ic = icOf(job.id);
    const dueAt = ic ? opsPlanDueAt(job, ic.icAssignedAt ?? ic.createdAt) : job.opsPlanDueAt;
    const mine = plan ? versions.filter((v) => v.opsPlanId === plan.id) : [];
    const latest = mine[0];
    const base = { jobId: job.id, opsPlanId: plan?.id ?? null, title: job.title, vendorName, startAt: job.startAt, dueAt, icName: ic?.name ?? null, version: mine.length };
    if (plan?.status === "submitted" && latest?.decision === "pending") {
      // As eligibleReviewers: a reviewer from settings who neither submitted this version nor is the IC.
      const canReview = reviewer && latest.submittedBy !== actor.userId && ic?.userId !== actor.userId;
      waiting.push({ ...base, waitingSince: latest.submittedAt, canReview, versionId: latest.id });
    } else if (plan?.status !== "agreed" && plan?.status !== "submitted" && dueAt && dueAt.getTime() < now.getTime()) {
      overdue.push({ ...base, waitingSince: null, canReview: false, versionId: latest?.id ?? null });
    }
  }
  return { overdue, waiting };
}

/** The coordinator to-do list (spec order is decided by the screen). */
export async function coordinatorTodo(actor: Actor, tx: Tx, now: Date = new Date()): Promise<CoordinatorTodo> {
  assertCan(actor, "job.update");
  const settings = await getSettings(tx);

  const review = isStaff(actor) ? await findOpenReview(tx) : null;
  let accessReview: CoordinatorTodo["accessReview"] = null;
  if (review) {
    const [c] = await tx
      .select({ total: sql<number>`count(*)::int`, decided: sql<number>`count(${accessReviewItems.decision})::int` })
      .from(accessReviewItems)
      .where(eq(accessReviewItems.reviewId, review.id));
    accessReview = { reviewId: review.id, total: c.total, decided: c.decided, dueAt: review.dueAt };
  }

  const locked = await lockedDetailsForTodo(tx, now);
  const lockedCounts = await signedUpCounts(tx, [...locked.started, ...locked.startingSoon].map((j) => j.id));
  const lockedRow = (j: (typeof locked.started)[number]): LockedRow => ({
    jobId: j.id,
    number: j.number,
    title: j.title,
    vendorName: j.vendorName,
    startAt: j.startAt,
    endAt: j.endAt,
    holdPlacedAt: j.holdPlacedAt,
    signedUp: lockedCounts.get(j.id) ?? 0,
    latePay: j.startAt.getTime() - j.holdPlacedAt.getTime() <= settings.lateVendorCancelHours * HOUR_MS,
  });

  // A multi-date request shows once, at its first date.
  const requested = await tx
    .select({ job: jobs, vendorName: vendors.name, locationName: vendorLocations.name })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
    .where(eq(jobs.state, "requested"))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
  const bySeries = new Map<string, typeof requested>();
  for (const r of requested) {
    const key = r.job.seriesId ?? r.job.id;
    bySeries.set(key, [...(bySeries.get(key) ?? []), r]);
  }
  const firsts = [...bySeries.values()];
  const summaries = await positionSummary(tx, firsts.map((g) => g[0].job.id));
  const requests: RequestRow[] = firsts.map((g) => {
    const { job, vendorName, locationName } = g[0];
    return {
      jobId: job.id,
      title: job.title,
      vendorName,
      locationName,
      startAt: job.startAt,
      endAt: job.endAt,
      dates: g.length,
      positions: summaries.get(job.id) ?? "",
      flex: job.flexEarliestStartAt && job.flexLatestEndAt ? { earliestStartAt: job.flexEarliestStartAt, latestEndAt: job.flexLatestEndAt } : null,
    };
  });

  const changes = (
    await tx
      .select({ id: jobChangeRequests.id, jobId: jobs.id, title: jobs.title, vendorName: vendors.name, at: jobChangeRequests.createdAt })
      .from(jobChangeRequests)
      .innerJoin(jobs, eq(jobs.id, jobChangeRequests.jobId))
      .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
      .where(eq(jobChangeRequests.status, "pending"))
      .orderBy(asc(jobChangeRequests.createdAt))
  ).map((r) => ({ requestId: r.id, jobId: r.jobId, title: r.title, vendorName: r.vendorName, requestedAt: r.at }));

  const notes = (
    await tx
      .select({ id: deputyNotes.id, body: deputyNotes.body, vendorName: vendors.name, locationName: vendorLocations.name, authorName: users.name, at: deputyNotes.submittedAt })
      .from(deputyNotes)
      .innerJoin(vendors, eq(vendors.id, deputyNotes.vendorId))
      .leftJoin(vendorLocations, eq(vendorLocations.id, deputyNotes.locationId))
      .innerJoin(users, eq(users.id, deputyNotes.submittedBy))
      .where(eq(deputyNotes.status, "pending"))
      .orderBy(asc(deputyNotes.submittedAt), asc(deputyNotes.id))
  ).map((r) => ({ id: r.id, body: r.body, vendorName: r.vendorName, locationName: r.locationName, authorName: r.authorName, submittedAt: r.at }));

  const flagRequests = (
    await tx
      .select({ id: qualificationRequests.id, userName: users.name, qualificationName: qualifications.name, note: qualificationRequests.note, at: qualificationRequests.createdAt })
      .from(qualificationRequests)
      .innerJoin(users, eq(users.id, qualificationRequests.userId))
      .innerJoin(qualifications, eq(qualifications.id, qualificationRequests.qualificationId))
      .where(eq(qualificationRequests.status, "pending"))
      .orderBy(asc(qualificationRequests.createdAt))
  ).map((r) => ({ id: r.id, userName: r.userName, qualificationName: r.qualificationName, note: r.note, requestedAt: r.at }));

  const missingContract = (await upcomingMissingContract(tx, now)).map((m) => ({ jobId: m.id, number: m.number, title: m.title, vendorId: m.vendorId, vendorName: m.vendorName, startAt: m.startAt }));

  const review_ = await listInvoicesForReview(actor, tx);
  const scheduled = review_.length
    ? await tx
        .select({ id: invoices.id, startAt: sql<Date>`coalesce(${assignments.plannedStartAt}, ${jobs.startAt})`, endAt: sql<Date>`coalesce(${assignments.plannedEndAt}, ${jobs.endAt})`, vendorSchedule: vendors.invoiceSendSchedule, sendByDefault: vendors.emailApprovedInvoices })
        .from(invoices)
        .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
        .innerJoin(jobs, eq(jobs.id, assignments.jobId))
        .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
        .where(inArray(invoices.id, review_.map((r) => r.id)))
    : [];
  const sched = new Map(scheduled.map((s) => [s.id, Math.round((new Date(s.endAt).getTime() - new Date(s.startAt).getTime()) / 60_000)]));
  const invoiceRows = review_.map((r) => ({
    ...r,
    formattedNumber: formatInvoiceNumber(settings.invoiceNumberPrefix, r.number),
    scheduledMinutes: sched.get(r.id) ?? r.workedMinutes,
    batched: effectiveSchedule(scheduled.find((x) => x.id === r.id)?.vendorSchedule ?? null, settings) !== "immediate",
    sendByDefault: scheduled.find((x) => x.id === r.id)?.sendByDefault ?? true,
  }));

  // Open payment issues on the coordinators' turn, straight from the invoices.
  const issueRows = await tx
    .select({ inv: invoices, issueId: paymentIssues.id, payeeName: users.name, vendorName: vendors.name })
    .from(invoices)
    .innerJoin(paymentIssues, and(eq(paymentIssues.invoiceId, invoices.id), eq(paymentIssues.status, "open")))
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(and(eq(invoices.status, "sent"), eq(invoices.responsibleParty, "coordinator")))
    .orderBy(asc(invoices.responsibleSince), asc(invoices.number));
  const issues: IssueRow[] = issueRows.map(({ inv, issueId, payeeName, vendorName }) => {
    const since = inv.responsibleSince ?? inv.sentAt ?? inv.createdAt;
    return {
      issueId,
      invoiceId: inv.id,
      number: formatInvoiceNumber(settings.invoiceNumberPrefix, inv.number),
      vendorName,
      payeeName,
      totalCents: inv.totalCents,
      since,
      day: daysWaiting(since, now),
      limitDays: settings.responseDays.coordinator,
    };
  });

  const ops = await opsPlanQueue(actor, tx, now);

  const soon = await tx
    .select({ id: jobs.id, title: jobs.title, vendorName: vendors.name, startAt: jobs.startAt })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(and(inArray(jobs.state, ["scheduled", "active"]), gt(jobs.startAt, now), lte(jobs.startAt, new Date(now.getTime() + 72 * HOUR_MS)), eq(vendors.paymentHold, false)))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
  const filled = await holdingCounts(tx, soon.map((j) => j.id));
  const needed = soon.length
    ? new Map(
        (
          await tx
            .select({ jobId: jobPositions.jobId, n: sql<number>`sum(${jobPositions.count})::int` })
            .from(jobPositions)
            .where(inArray(jobPositions.jobId, soon.map((j) => j.id)))
            .groupBy(jobPositions.jobId)
        ).map((r) => [r.jobId, r.n]),
      )
    : new Map<string, number>();
  const unfilled = soon
    .map((j) => ({ jobId: j.id, title: j.title, vendorName: j.vendorName, startAt: j.startAt, open: (needed.get(j.id) ?? 0) - (filled.get(j.id) ?? 0) }))
    .filter((j) => j.open > 0);

  const locks: LockRow[] = (await lockedPeople(tx, now)).map((p) => ({ userId: p.userId, name: p.name, unbilled: p.unbilledCount, unacknowledged: p.unacknowledgedCount }));

  return {
    accessReview,
    lockedStarted: locked.started.map(lockedRow),
    lockedSoon: locked.startingSoon.map(lockedRow),
    requests,
    changes,
    notes,
    flagRequests,
    missingContract,
    invoices: invoiceRows,
    issues,
    opsOverdue: ops.overdue,
    opsWaiting: ops.waiting,
    unfilled,
    locks,
    ratesOutOfRange: await ratesOutsideRange(tx, settings, now),
    sendInvoices: await dueInvoiceBatches(tx, settings, now),
    departed: isStaff(actor) ? await departedUnbilled(tx, now) : [],
  };
}

export type UnsentRow = { id: string; number: string; payeeName: string; vendorId: string; vendorName: string; jobTitle: string; totalCents: Cents; deputyPaid: boolean };

/** Invoices approved without sending, by number, for coordinators to send later. */
export async function unsentInvoices(actor: Actor, tx: Tx): Promise<UnsentRow[]> {
  assertCan(actor, "invoice.review");
  const { invoiceNumberPrefix } = await getSettings(tx);
  const rows = await tx
    .select({ inv: invoices, payeeName: users.name, vendorName: vendors.name, jobTitle: jobs.title })
    .from(invoices)
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(and(eq(invoices.status, "approved_unsent"), isNull(invoices.deputyPaidAt)))
    .orderBy(asc(invoices.number));
  return rows.map((r) => ({
    id: r.inv.id,
    number: formatInvoiceNumber(invoiceNumberPrefix, r.inv.number),
    payeeName: r.payeeName,
    vendorId: r.inv.vendorId,
    vendorName: r.vendorName,
    jobTitle: r.jobTitle,
    totalCents: r.inv.totalCents,
    deputyPaid: r.inv.deputyPaidAt !== null,
  }));
}

export type BoardRow = {
  invoiceId: string;
  number: string;
  status: "pending_review" | "sent" | "returned";
  kind: "detail" | "late_cancel";
  payeeName: string;
  vendorId: string;
  vendorName: string;
  jobTitle: string;
  totalCents: Cents;
  party: Party;
  since: Date | null;
  /** Whole days since the party's turn began (at least 1), against the party's response time. */
  day: number;
  limitDays: number;
  overdue: boolean;
  vendorReportsPaid: boolean;
  vendorOnHold: boolean;
  issueId: string | null;
};

export type PaymentsBoard = {
  rows: BoardRow[];
  totals: Record<Party, { cents: Cents; count: number; overdue: number }>;
};

/** Every unpaid invoice (waiting for review, sent or returned), grouped by whose turn it is, oldest turn first. */
export async function paymentsBoard(actor: Actor, tx: Tx, now: Date = new Date()): Promise<PaymentsBoard> {
  assertCan(actor, "invoice.review");
  const s = await getSettings(tx);
  const rows = await tx
    .select({ inv: invoices, payeeName: users.name, vendorName: vendors.name, hold: vendors.paymentHold, jobTitle: jobs.title, issueId: paymentIssues.id })
    .from(invoices)
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .leftJoin(paymentIssues, and(eq(paymentIssues.invoiceId, invoices.id), eq(paymentIssues.status, "open")))
    .where(inArray(invoices.status, ["pending_review", "sent", "returned"]))
    .orderBy(asc(invoices.responsibleSince), asc(invoices.number));
  const totals: PaymentsBoard["totals"] = { vendor: { cents: 0, count: 0, overdue: 0 }, deputy: { cents: 0, count: 0, overdue: 0 }, coordinator: { cents: 0, count: 0, overdue: 0 } };
  const out: BoardRow[] = [];
  for (const r of rows) {
    const party = (r.inv.responsibleParty ?? "vendor") as Party;
    const since = r.inv.responsibleSince ?? r.inv.sentAt ?? r.inv.createdAt;
    const overdue = isOverdue({ responsibleParty: party, responsibleSince: since }, now, s);
    const day = daysWaiting(since, now);
    out.push({
      invoiceId: r.inv.id,
      number: formatInvoiceNumber(s.invoiceNumberPrefix, r.inv.number),
      status: r.inv.status as BoardRow["status"],
      kind: r.inv.kind,
      payeeName: r.payeeName,
      vendorId: r.inv.vendorId,
      vendorName: r.vendorName,
      jobTitle: r.jobTitle,
      totalCents: r.inv.totalCents,
      party,
      since,
      day,
      limitDays: s.responseDays[party],
      overdue,
      vendorReportsPaid: !!r.inv.vendorPaidAt && !r.inv.deputyPaidAt,
      vendorOnHold: r.hold,
      issueId: r.issueId,
    });
    totals[party].cents += r.inv.totalCents;
    totals[party].count += 1;
    if (overdue) totals[party].overdue += 1;
  }
  return { rows: out, totals };
}

type StaffTimelineEvent = { id: string; event: string; party: string | null; note: string | null; at: Date; actorName: string | null };

export type StaffInvoice = {
  id: string;
  number: string;
  status: (typeof invoices.$inferSelect)["status"];
  kind: (typeof invoices.$inferSelect)["kind"];
  revision: number;
  payeeUserId: string;
  payeeName: string;
  payeeEmail: string;
  payeePhone: string | null;
  vendorId: string;
  vendorName: string;
  /** Where a resend goes by default. */
  vendorBillingEmails: string[];
  vendorOnHold: boolean;
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  scheduled: { startAt: Date; endAt: Date };
  worked: { startAt: Date; endAt: Date } | null;
  changeReason: string | null;
  minutes: number;
  rateCents: Cents;
  totalCents: Cents;
  minimumOverrideMinutes: number | null;
  sentAt: Date | null;
  /** How this vendor's approved invoices go out (its override, else the agency setting). */
  sendSchedule: SendSchedule;
  /** On a queued invoice: "Queued for the weekly send on Fri, Nov 27." */
  queuedSend: string | null;
  /** The vendor's "Email approved invoices to this vendor": pre-selects Approve and send, or Approve, don't send. */
  sendByDefault: boolean;
  /** "Send now" applies: approved without sending and not marked paid. */
  canSendNow: boolean;
  /** "Send paid invoice" applies: paid and never sent or queued. */
  canSendPaid: boolean;
  attachW9: boolean;
  payeeHasW9: boolean;
  party: Party | null;
  dueAt: Date | null;
  overdue: boolean;
  issueId: string | null;
  issueWaitingOn: Party | null;
  timeline: StaffTimelineEvent[];
};

export type RateOverride = { reason: string; byName: string; at: Date };

/** The approval of a detail's out-of-range rate, with the approver's name, or null. */
export async function rateOverrideOf(tx: Tx, job: { rateOverrideReason: string | null; rateOverrideBy: string | null; rateOverrideAt: Date | null }): Promise<RateOverride | null> {
  if (!job.rateOverrideReason || !job.rateOverrideAt) return null;
  const [u] = job.rateOverrideBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, job.rateOverrideBy)) : [];
  return { reason: job.rateOverrideReason, byName: u?.name ?? "a coordinator", at: job.rateOverrideAt };
}

/** One invoice with its full timeline (author names included), for coordinators and admins. */
export async function staffInvoice(actor: Actor, tx: Tx, id: string, now: Date = new Date()): Promise<StaffInvoice> {
  assertCan(actor, "invoice.review");
  const [r] = await tx
    .select({ inv: invoices, payeeName: users.name, payeeEmail: users.email, payeePhone: users.phone, vendorName: vendors.name, hold: vendors.paymentHold, vendorSchedule: vendors.invoiceSendSchedule, sendByDefault: vendors.emailApprovedInvoices, billingEmails: vendors.billingEmails, job: jobs, a: assignments })
    .from(invoices)
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(eq(invoices.id, id));
  if (!r) throw new NotFoundError("Invoice not found.");
  const s = await getSettings(tx);
  const events = await tx
    .select({ e: invoiceEvents, actorName: users.name })
    .from(invoiceEvents)
    .leftJoin(users, eq(users.id, invoiceEvents.actorUserId))
    .where(eq(invoiceEvents.invoiceId, id))
    .orderBy(asc(invoiceEvents.at), asc(invoiceEvents.createdAt), asc(invoiceEvents.id));
  const [issue] = await tx.select().from(paymentIssues).where(and(eq(paymentIssues.invoiceId, id), eq(paymentIssues.status, "open")));
  const party = r.inv.responsibleParty as Party | null;
  const since = r.inv.responsibleSince;
  return {
    id: r.inv.id,
    number: formatInvoiceNumber(s.invoiceNumberPrefix, r.inv.number),
    status: r.inv.status,
    kind: r.inv.kind,
    revision: r.inv.revision,
    payeeUserId: r.inv.payeeUserId,
    payeeName: r.payeeName,
    payeeEmail: r.payeeEmail,
    payeePhone: r.payeePhone,
    vendorId: r.inv.vendorId,
    vendorName: r.vendorName,
    vendorBillingEmails: r.billingEmails,
    vendorOnHold: r.hold,
    jobId: r.job.id,
    jobNumber: r.job.number,
    jobTitle: r.job.title,
    scheduled: { startAt: r.a.plannedStartAt ?? r.job.startAt, endAt: r.a.plannedEndAt ?? r.job.endAt },
    worked: r.a.actualStartAt && r.a.actualEndAt ? { startAt: r.a.actualStartAt, endAt: r.a.actualEndAt } : null,
    changeReason: r.a.hoursChangeReason,
    minutes: r.inv.minutes,
    rateCents: r.inv.rateCents,
    totalCents: r.inv.totalCents,
    minimumOverrideMinutes: r.inv.minimumOverrideMinutes,
    sentAt: r.inv.sentAt,
    sendSchedule: effectiveSchedule(r.vendorSchedule, s),
    queuedSend: queuedSendFor(r.inv, r.vendorSchedule, s, now),
    sendByDefault: r.sendByDefault,
    canSendNow: sendableLater(r.inv) === "unsent",
    canSendPaid: sendableLater(r.inv) === "paid",
    attachW9: r.inv.attachW9,
    payeeHasW9: Boolean(await currentW9(tx, r.inv.payeeUserId)),
    party: r.inv.status === "paid" || r.inv.status === "written_off" ? null : party,
    dueAt: party && since ? responsibleDueAt(party, since, s) : null,
    overdue: party ? isOverdue({ responsibleParty: party, responsibleSince: since }, now, s) : false,
    issueId: issue?.id ?? null,
    issueWaitingOn: (issue?.waitingOn as Party | null) ?? (issue ? "coordinator" : null),
    timeline: events.map(({ e, actorName }) => ({ id: e.id, event: e.event, party: e.party, note: e.note, at: e.at, actorName })),
  };
}

type JobRosterAdminRow = {
  assignmentId: string;
  userId: string;
  name: string;
  position: string;
  status: (typeof assignments.$inferSelect)["status"];
  requestedAt: Date;
  backupPosition: number | null;
  isIncidentCommander: boolean;
  overrideReason: string | null;
  removalReason: string | null;
} & HistoryEntry;

export type JobAdmin = {
  vendorName: string;
  vendorOnHold: boolean;
  vendorMinimumMinutes: number | null;
  locationName: string | null;
  locationAddress: string | null;
  locationPin: { lat: number; lng: number } | null;
  typeName: string;
  /** Pay at the base rate; each position carries its own rate and pay (base plus its differential). */
  totalCents: Cents;
  /** Every spot at its position's pay: what the vendor pays when the detail is full. */
  vendorTotalCents: Cents;
  positions: Array<{ id: string; positionTypeId: string; name: string; count: number; filled: number; backups: number; isIncidentCommander: boolean; rateCents: Cents; totalCents: Cents; differentialCents: Cents }>;
  roster: JobRosterAdminRow[];
  /** Cancels and reactivations of the detail, oldest first, with who and why. */
  events: DetailEvent[];
  seriesCount: number;
  laterInSeries: number;
  pendingChanges: Array<{ id: string; requestedAt: Date; patch: unknown }>;
  locked: boolean;
  /** A locked detail whose hold came inside the late cancellation window: canceling pays the people signed up. */
  latePay: boolean;
  lateCanceled: number;
};

/** What a coordinator needs on a job page beyond getJob: roster with ids and statuses, series size, pending vendor changes. */
export async function jobAdmin(actor: Actor, tx: Tx, jobId: string): Promise<JobAdmin> {
  assertCan(actor, "job.update");
  const [row] = await tx
    .select({ job: jobs, vendorName: vendors.name, hold: vendors.paymentHold, vendorMin: vendors.minimumBillableMinutes, locationName: vendorLocations.name, address: vendorLocations.address, lat: vendorLocations.lat, lng: vendorLocations.lng, typeName: sql<string>`(select name from job_types where id = ${jobs.typeId})` })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
    .where(eq(jobs.id, jobId));
  if (!row) throw new NotFoundError("Job not found.");
  const settings = await getSettings(tx);
  const pos = await tx
    .select({ p: jobPositions, name: positionTypes.name, ic: positionTypes.isIncidentCommander })
    .from(jobPositions)
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(eq(jobPositions.jobId, jobId))
    .orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const people = await tx
    .select({ a: assignments, name: users.name, position: positionTypes.name })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(eq(assignments.jobId, jobId))
    .orderBy(asc(assignments.requestedAt), asc(assignments.id));
  const holding: readonly string[] = HOLDING_STATUSES;
  // Every row, in sign-up order: a canceled row stays with how it ended; a later sign-up is its own row.
  const history = await signupHistory(tx, people.map(({ a }) => a));
  const span = { startAt: row.job.startAt, endAt: row.job.endAt };
  const positionPay = (p: { rateDifferentialCents: Cents }) => scheduledPayCents({ ...row.job, rateCents: positionRateCents(row.job.rateCents, p) }, row.vendorMin, settings, span);
  const series = row.job.seriesId
    ? await tx.select({ id: jobs.id, startAt: jobs.startAt }).from(jobs).where(and(eq(jobs.seriesId, row.job.seriesId), notInArray(jobs.state, ["canceled", "declined"])))
    : [];
  const changes = await tx.select().from(jobChangeRequests).where(and(eq(jobChangeRequests.jobId, jobId), eq(jobChangeRequests.status, "pending"))).orderBy(asc(jobChangeRequests.createdAt));
  const [hold] = await tx.select().from(vendorHolds).where(and(eq(vendorHolds.vendorId, row.job.vendorId), isNull(vendorHolds.resolvedAt))).limit(1);
  const locked = !!hold && row.job.startAt.getTime() > hold.placedAt.getTime() && (row.job.state === "scheduled" || row.job.state === "active");
  return {
    vendorName: row.vendorName,
    vendorOnHold: row.hold,
    vendorMinimumMinutes: row.vendorMin,
    locationName: row.locationName,
    locationAddress: row.address,
    locationPin: row.lat !== null && row.lng !== null ? { lat: row.lat, lng: row.lng } : null,
    typeName: row.typeName,
    totalCents: scheduledPayCents(row.job, row.vendorMin, settings, { startAt: row.job.startAt, endAt: row.job.endAt }),
    vendorTotalCents: pos.reduce((n, { p }) => n + p.count * positionPay(p), 0),
    positions: pos.map(({ p, name, ic }) => ({
      rateCents: positionRateCents(row.job.rateCents, p),
      totalCents: positionPay(p),
      differentialCents: p.rateDifferentialCents,
      id: p.id,
      positionTypeId: p.positionTypeId,
      name,
      count: p.count,
      filled: people.filter((x) => x.a.jobPositionId === p.id && holding.includes(x.a.status)).length,
      backups: people.filter((x) => x.a.jobPositionId === p.id && x.a.status === "backup").length,
      isIncidentCommander: ic,
    })),
    roster: people.map(({ a, name, position }) => ({
      assignmentId: a.id,
      userId: a.userId,
      name,
      position,
      status: a.status,
      requestedAt: a.requestedAt,
      ...history.get(a.id)!,
      backupPosition: a.backupPosition,
      isIncidentCommander: a.isIncidentCommander,
      overrideReason: a.overrideReason,
      removalReason: a.removalReason,
    })),
    events: await detailEvents(tx, jobId),
    seriesCount: series.length,
    laterInSeries: series.filter((s) => s.startAt.getTime() >= row.job.startAt.getTime()).length,
    pendingChanges: changes.map((c) => ({ id: c.id, requestedAt: c.createdAt, patch: c.patch })),
    locked,
    latePay: locked && !!hold && row.job.startAt.getTime() - hold.placedAt.getTime() <= settings.lateVendorCancelHours * HOUR_MS,
    lateCanceled: people.filter((x) => x.a.status === "late_canceled").length,
  };
}

export type VendorListRow = { id: string; name: string; active: boolean; paymentHold: boolean; contactName: string | null; upcoming: number };

export async function vendorDirectory(actor: Actor, tx: Tx, now: Date = new Date()): Promise<VendorListRow[]> {
  assertCan(actor, "vendor.manage");
  const rows = await tx
    .select({
      v: vendors,
      upcoming: sql<number>`(select count(*)::int from jobs j where j.vendor_id = ${vendors.id} and j.start_at > ${now.toISOString()}::timestamptz and j.state in ('scheduled','active','requested'))`,
    })
    .from(vendors)
    .orderBy(asc(vendors.name));
  return rows.map(({ v, upcoming }) => ({ id: v.id, name: v.name, active: v.active, paymentHold: v.paymentHold, contactName: v.contactName, upcoming }));
}

export type VendorRecord = {
  vendor: typeof vendors.$inferSelect;
  typeName: string | null;
  locations: Array<typeof vendorLocations.$inferSelect & { details: number }>;
  /** Site contacts, active first. */
  contacts: Array<typeof vendorContacts.$inferSelect>;
  documents: Array<typeof vendorDocuments.$inferSelect>;
  notes: Array<{ id: string; body: string; status: string; locationName: string | null; authorName: string; submittedAt: Date }>;
  payments: { overdueCents: Cents; waitingCents: Cents; pastIssues: number };
  holds: Array<{ placedAt: Date; reason: string | null; resolvedAt: Date | null; outcome: string | null }>;
  restrictions: Array<{ id: string; userName: string; reason: string | null; placedBy: string | null; createdAt: Date }>;
  logins: Array<{ userId: string; name: string; email: string; lastSignInAt: Date | null; active: boolean }>;
};

/** Everything on a vendor's record, for coordinators and admins. Deputy notes stay staff-only. */
export async function vendorRecord(actor: Actor, tx: Tx, vendorId: string, now: Date = new Date()): Promise<VendorRecord> {
  assertCan(actor, "vendor.manage");
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, vendorId));
  if (!vendor) throw new NotFoundError("Vendor not found.");
  const [type] = vendor.typeId ? await tx.select({ name: vendorTypes.name }).from(vendorTypes).where(eq(vendorTypes.id, vendor.typeId)) : [];
  const locations = await tx
    .select({ l: vendorLocations, details: sql<number>`(select count(*)::int from jobs j where j.location_id = ${vendorLocations.id} and j.state not in ('declined'))` })
    .from(vendorLocations)
    .where(eq(vendorLocations.vendorId, vendorId))
    .orderBy(desc(vendorLocations.active), asc(vendorLocations.name));
  const contacts = await tx.select().from(vendorContacts).where(eq(vendorContacts.vendorId, vendorId)).orderBy(desc(vendorContacts.active), asc(vendorContacts.name));
  const documents = await tx.select().from(vendorDocuments).where(eq(vendorDocuments.vendorId, vendorId)).orderBy(desc(vendorDocuments.createdAt));
  const notes = await tx
    .select({ id: deputyNotes.id, body: deputyNotes.body, status: deputyNotes.status, locationName: vendorLocations.name, authorName: users.name, submittedAt: deputyNotes.submittedAt })
    .from(deputyNotes)
    .innerJoin(users, eq(users.id, deputyNotes.submittedBy))
    .leftJoin(vendorLocations, eq(vendorLocations.id, deputyNotes.locationId))
    .where(and(eq(deputyNotes.vendorId, vendorId), inArray(deputyNotes.status, ["pending", "approved"])))
    .orderBy(desc(deputyNotes.submittedAt));
  const board = await paymentsBoard(actor, tx, now);
  const mine = board.rows.filter((r) => r.vendorId === vendorId);
  const [past] = await tx
    .select({ n: sql<number>`count(*)::int` })
    .from(paymentIssues)
    .innerJoin(invoices, eq(invoices.id, paymentIssues.invoiceId))
    .where(and(eq(invoices.vendorId, vendorId), ne(paymentIssues.status, "open")));
  const holds = await tx.select().from(vendorHolds).where(eq(vendorHolds.vendorId, vendorId)).orderBy(desc(vendorHolds.placedAt));
  const placer = sql<string | null>`(select name from users u where u.id = ${vendorRestrictions.createdBy})`;
  const restrictions = await tx
    .select({ id: vendorRestrictions.id, userName: users.name, reason: vendorRestrictions.reason, placedBy: placer, createdAt: vendorRestrictions.createdAt })
    .from(vendorRestrictions)
    .innerJoin(users, eq(users.id, vendorRestrictions.userId))
    .where(and(eq(vendorRestrictions.vendorId, vendorId), isNull(vendorRestrictions.liftedAt)))
    .orderBy(desc(vendorRestrictions.createdAt));
  const logins = await tx
    .select({ userId: users.id, name: users.name, email: users.email, lastSignInAt: users.lastSignInAt, active: users.active })
    .from(vendorUsers)
    .innerJoin(users, eq(users.id, vendorUsers.userId))
    .where(eq(vendorUsers.vendorId, vendorId))
    .orderBy(asc(users.name));
  return {
    vendor,
    typeName: type?.name ?? null,
    locations: locations.map(({ l, details }) => ({ ...l, details })),
    contacts,
    documents,
    notes,
    payments: {
      overdueCents: mine.filter((r) => r.overdue).reduce((n, r) => n + r.totalCents, 0),
      waitingCents: mine.filter((r) => !r.overdue).reduce((n, r) => n + r.totalCents, 0),
      pastIssues: past?.n ?? 0,
    },
    holds: holds.map((h) => ({ placedAt: h.placedAt, reason: h.reason, resolvedAt: h.resolvedAt, outcome: h.outcome })),
    restrictions,
    logins,
  };
}

/** Active personnel, coordinators and admins by name: for pickers (assign, restrict, earnings lookup). */
export async function staffDirectory(actor: Actor, tx: Tx): Promise<Array<{ id: string; name: string; role: string }>> {
  assertCan(actor, "user.manage");
  return tx
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.active, true), ne(users.role, "vendor")))
    .orderBy(asc(users.name));
}

export type DetailFormOptions = {
  vendors: Array<{ id: string; name: string; defaultRateCents: Cents | null; minimumBillableMinutes: number | null; paymentHold: boolean }>;
  locations: Array<{ id: string; vendorId: string; name: string; address: string | null }>;
  /** Active site contacts of every active vendor, offered in the Site contact dropdown. */
  contacts: Array<{ id: string; vendorId: string; name: string; phone: string }>;
  types: Array<{ id: string; name: string }>;
  /** `rateDifferentialCents` is added to the detail's base rate for that position. */
  positionTypes: Array<{ id: string; name: string; rateDifferentialCents: Cents }>;
  defaultPositionTypeId: string | null;
  agencyDefaultRateCents: Cents;
  rateRange: { rateMinCents: Cents | null; rateMaxCents: Cents | null };
  minimumBillableMinutes: number;
  hourRoundingMinutes: number;
  weekStartsOn: number;
  /** Release instant (ISO) for details in each month ("YYYY-MM"), from last month through two years out. */
  releaseByMonth: Record<string, string>;
};

/** Choices and rules the detail form needs: active vendors, their active locations, types, positions and release dates. */
export async function detailFormOptions(actor: Actor, tx: Tx, now: Date = new Date()): Promise<DetailFormOptions> {
  assertCan(actor, "job.create");
  const s = await getSettings(tx);
  const vendorRows = await tx.select().from(vendors).where(eq(vendors.active, true)).orderBy(asc(vendors.name));
  const locations = await tx
    .select({ id: vendorLocations.id, vendorId: vendorLocations.vendorId, name: vendorLocations.name, address: vendorLocations.address })
    .from(vendorLocations)
    .where(eq(vendorLocations.active, true))
    .orderBy(asc(vendorLocations.name));
  const contacts = await tx
    .select({ id: vendorContacts.id, vendorId: vendorContacts.vendorId, name: vendorContacts.name, phone: vendorContacts.phone })
    .from(vendorContacts)
    .where(eq(vendorContacts.active, true))
    .orderBy(asc(vendorContacts.name));
  const types = await tx.select({ id: jobTypes.id, name: jobTypes.name }).from(jobTypes).where(eq(jobTypes.active, true)).orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name));
  const posTypes = await tx.select({ id: positionTypes.id, name: positionTypes.name, rateDifferentialCents: positionTypes.rateDifferentialCents }).from(positionTypes).where(eq(positionTypes.active, true)).orderBy(asc(positionTypes.sortOrder), asc(positionTypes.name));
  const p = agencyDateParts(now);
  const releaseByMonth: Record<string, string> = {};
  for (let i = -1; i <= 24; i++) {
    const idx = p.year * 12 + (p.month - 1) + i;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    releaseByMonth[`${y}-${String(m).padStart(2, "0")}`] = releaseAt(agencyInstant(y, m, 1, 12, 0), s).toISOString();
  }
  return {
    vendors: vendorRows.map((v) => ({ id: v.id, name: v.name, defaultRateCents: v.defaultRateCents, minimumBillableMinutes: v.minimumBillableMinutes, paymentHold: v.paymentHold })),
    locations,
    contacts,
    types,
    positionTypes: posTypes,
    defaultPositionTypeId: s.defaultPositionTypeId,
    agencyDefaultRateCents: s.agencyDefaultRateCents,
    rateRange: { rateMinCents: s.rateMinCents, rateMaxCents: s.rateMaxCents },
    minimumBillableMinutes: s.minimumBillableMinutes,
    hourRoundingMinutes: s.hourRoundingMinutes,
    weekStartsOn: s.weekStartsOn,
    releaseByMonth,
  };
}
