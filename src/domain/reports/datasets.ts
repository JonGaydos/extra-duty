import { and, asc, eq, gte, inArray, lte, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  assignments,
  userQualifications,
  assignmentStatus,
  auditLog,
  billingLockOverrides,
  invoices,
  invoiceStatus,
  jobChangeRequests,
  jobs,
  jobState,
  jobTypes,
  messages,
  opsPlans,
  opsPlanStatus,
  paymentIssues,
  paymentIssueStatus,
  seasons,
  users,
  vendorHolds,
  vendorLocations,
  vendors,
} from "@/db/schema";
import { DEPARTURE_REMOVE_ACTION, GAVE_AWAY_ACTION, SUSPENSION_REMOVAL_REASON, SUSPENSION_REMOVE_ACTION } from "@/domain/assignments/history";
import { seasonFor } from "@/domain/caps/seasons";
import { minutesBetween } from "@/domain/time/agency-time";
import { closedPaidAtMs, fromMs, isBilled, paidDate } from "./earnings";

export type DatasetName =
  | "jobs"
  | "assignments"
  | "invoices"
  | "payments"
  | "payment_issues"
  | "cancellations"
  | "no_shows"
  | "vendor_requests"
  | "ops_plans"
  | "locks_and_overrides"
  | "suspensions"
  | "messages"
  | "audit"
  | "activity";

/** The last five (responsible_party, age_bucket, action, entity_type) are added for the unpaid-by-age and audit reports. */
export type GroupBy =
  | "day"
  | "week"
  | "month"
  | "year"
  | "deputy"
  | "vendor"
  | "job_type"
  | "location"
  | "status"
  | "responsible_party"
  | "age_bucket"
  | "action"
  | "entity_type";

/** Added to the five base measures: `recipients` (messages), `billed_count` (invoices that count as billed) and the monthly cap pair (assignments, grouped by month). */
export type Measure =
  | "count"
  | "billed_count"
  | "hours"
  | "billed_cents"
  | "paid_cents"
  | "outstanding_cents"
  | "recipients"
  | "cap_hours"
  | "over_under_hours"
  | "details_worked"
  | "earned_cents"
  | "signups"
  | "gave_away"
  | "late_cancels"
  | "removals"
  | "suspension_removals"
  | "departure_removals"
  | "no_shows"
  | "cancellations"
  | "cancellation_rate";

export type FilterName = "userIds" | "vendorIds" | "typeIds" | "locationIds" | "statuses" | "rankIds" | "qualificationIds";

export type ReportFilters = { [K in FilterName]?: string[] };

export type ReportSpec = {
  dataset: DatasetName;
  /** Inclusive bounds, in instants. */
  from: Date;
  to: Date;
  filters: ReportFilters;
  groupBy: GroupBy[];
  measures: Measure[];
};

export const MAX_ROWS = 50_000;

/** One source row, reduced to what a grouping or a measure may read. Message bodies and audit before/after are never loaded. */
export type Fact = {
  at: Date;
  userId: string | null;
  userName: string | null;
  vendorId: string | null;
  vendorName: string | null;
  typeId: string | null;
  typeName: string | null;
  locationId: string | null;
  locationName: string | null;
  status: string;
  responsibleParty: string | null;
  ageDays: number | null;
  action: string | null;
  entityType: string | null;
  minutes: number;
  /** 1 when the invoice counts as billed (pending review, sent or paid). */
  billedCount: number;
  /** The season's monthly cap for the month of `at`, in minutes; null when none. */
  monthCapMinutes: number | null;
  billed: number;
  paid: number;
  outstanding: number;
  recipients: number;
  /** Personnel activity: what became of one sign-up (or `roster`, a person with nothing in the period). */
  activity: ActivityKind | null;
  /** Personnel activity: billed invoice total for the sign-up, in cents. */
  earned: number;
};

/**
 * What became of a sign-up. `worked` is billed or paid for a detail; `late_cancel` is a vendor's late
 * cancellation (paid or not), shown but never counted against the person; `gave_away` is the person canceling their own sign-up; `canceled` is the agency or the system
 * releasing it (the detail was canceled, a shorter shift was declined) and never counts against the person;
 * `open` is still signed up, a backup or pending.
 */
export type ActivityKind = "worked" | "late_cancel" | "gave_away" | "removed" | "suspension_removed" | "departure_removed" | "no_show" | "canceled" | "open" | "roster";

const blank: Fact = {
  at: new Date(0),
  userId: null,
  userName: null,
  vendorId: null,
  vendorName: null,
  typeId: null,
  typeName: null,
  locationId: null,
  locationName: null,
  status: "",
  responsibleParty: null,
  ageDays: null,
  action: null,
  entityType: null,
  minutes: 0,
  billedCount: 0,
  monthCapMinutes: null,
  billed: 0,
  paid: 0,
  outstanding: 0,
  recipients: 0,
  activity: null,
  earned: 0,
};
const fact = (f: Partial<Fact> & Pick<Fact, "at" | "status">): Fact => ({ ...blank, ...f });

export type Dataset = {
  title: string;
  groupings: readonly GroupBy[];
  measures: readonly Measure[];
  filters: readonly FilterName[];
  /** Allowed status values; omitted when any text is a valid status (the audit action). */
  statuses?: readonly string[];
  /** Loads at most MAX_ROWS + 1 rows so the caller can refuse an oversized report. */
  load(tx: Tx, spec: ReportSpec, now: Date): Promise<Fact[]>;
};

const TIME: GroupBy[] = ["day", "week", "month", "year"];
const JOB_DIMS: GroupBy[] = ["vendor", "job_type", "location"];
const ALL_FILTERS: FilterName[] = ["userIds", "vendorIds", "typeIds", "locationIds", "statuses"];
const DAY_MS = 86_400_000;

const list = (col: Parameters<typeof inArray>[0], values: string[] | undefined): SQL | undefined => (values && values.length > 0 ? inArray(col, values) : undefined);

function ageBucket(days: number): string {
  if (days <= 30) return "0-30";
  if (days <= 60) return "31-60";
  if (days <= 90) return "61-90";
  return "91+";
}

/** Job, vendor, type and location columns shared by the job-based datasets. */
const jobDims = { vendorName: vendors.name, typeName: jobTypes.name, locationName: vendorLocations.name };

function jobFilters(spec: ReportSpec): (SQL | undefined)[] {
  return [list(jobs.vendorId, spec.filters.vendorIds), list(jobs.typeId, spec.filters.typeIds), list(jobs.locationId, spec.filters.locationIds)];
}

const assignmentRows = (statuses: readonly string[] | undefined) => async (tx: Tx, spec: ReportSpec): Promise<Fact[]> => {
  const requested = spec.filters.statuses ?? [];
  const wanted = statuses ? (requested.length > 0 ? statuses.filter((s) => requested.includes(s)) : [...statuses]) : requested;
  if (statuses && wanted.length === 0) return [];
  const allSeasons = await tx.select().from(seasons);
  const rows = await tx
    .select({ a: assignments, job: jobs, userName: users.name, ...jobDims })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .innerJoin(jobTypes, eq(jobTypes.id, jobs.typeId))
    .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(
      and(
        gte(jobs.startAt, spec.from),
        lte(jobs.startAt, spec.to),
        list(assignments.userId, spec.filters.userIds),
        ...jobFilters(spec),
        wanted.length > 0 ? inArray(assignments.status, wanted as (typeof assignmentStatus.enumValues)[number][]) : undefined,
      ),
    )
    .orderBy(asc(jobs.startAt), asc(assignments.id))
    .limit(MAX_ROWS + 1);
  return rows.map(({ a, job, userName, vendorName, typeName, locationName }) => {
    const start = a.actualStartAt ?? a.plannedStartAt ?? job.startAt;
    const end = a.actualEndAt ?? a.plannedEndAt ?? job.endAt;
    return fact({
      at: job.startAt,
      userId: a.userId,
      userName,
      vendorId: job.vendorId,
      vendorName,
      typeId: job.typeId,
      typeName,
      locationId: job.locationId,
      locationName,
      status: a.status,
      minutes: minutesBetween(start, end),
      monthCapMinutes: seasonFor(job.startAt, allSeasons)?.monthCapMinutes ?? null,
    });
  });
};

const ASSIGNMENT_DIMS: GroupBy[] = [...TIME, "deputy", ...JOB_DIMS, "status"];
const invoiceStatuses = invoiceStatus.enumValues;

/** Invoices joined to their job. `where` adds to the base filters; the loader maps each to a fact. */
async function invoiceRows(tx: Tx, spec: ReportSpec, where: (SQL | undefined)[], now: Date, order: SQL[]) {
  const rows = await tx
    .select({ inv: invoices, job: jobs, userName: users.name, closedPaidAt: closedPaidAtMs.mapWith(fromMs), ...jobDims })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .innerJoin(jobTypes, eq(jobTypes.id, jobs.typeId))
    .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .where(
      and(
        list(invoices.payeeUserId, spec.filters.userIds),
        list(invoices.vendorId, spec.filters.vendorIds),
        list(jobs.typeId, spec.filters.typeIds),
        list(jobs.locationId, spec.filters.locationIds),
        list(invoices.status, spec.filters.statuses),
        ...where,
      ),
    )
    .orderBy(...order)
    .limit(MAX_ROWS + 1);
  return rows.map(({ inv, job, userName, closedPaidAt, vendorName, typeName, locationName }) => {
    const paid = paidDate({ status: inv.status, deputyPaidAt: inv.deputyPaidAt, closedPaidAt });
    const billed = isBilled(inv.status);
    return {
      paid,
      billed,
      f: fact({
        at: job.startAt,
        userId: inv.payeeUserId,
        userName,
        vendorId: inv.vendorId,
        vendorName,
        typeId: job.typeId,
        typeName,
        locationId: job.locationId,
        locationName,
        status: inv.status,
        responsibleParty: inv.responsibleParty ?? "none",
        ageDays: Math.max(0, Math.floor((now.getTime() - (inv.sentAt ?? inv.createdAt).getTime()) / DAY_MS)),
        minutes: billed ? inv.minutes : 0,
        billedCount: billed ? 1 : 0,
        billed: billed ? inv.totalCents : 0,
        paid: paid ? inv.totalCents : 0,
        outstanding: billed && !paid ? inv.totalCents : 0,
      }),
      inv,
    };
  });
}

/** When the person was paid (epoch ms), as in `paidDate`, for filtering by payment date in SQL. */
const paidAtMs = sql`coalesce((extract(epoch from ${invoices.deputyPaidAt}) * 1000)::bigint, case when ${invoices.status} = 'paid' then ${closedPaidAtMs} end)`;

export const DATASETS: Record<DatasetName, Dataset> = {
  jobs: {
    title: "Jobs",
    groupings: [...TIME, ...JOB_DIMS, "status"],
    measures: ["count", "hours"],
    filters: ["vendorIds", "typeIds", "locationIds", "statuses"],
    // Not the job state alone: scheduled and active jobs are split into filled, open and expired (started with spots unfilled).
    statuses: ["requested", "declined", "canceled", "open", "filled", "expired"],
    async load(tx, spec, now) {
      const needed = sql`coalesce((select sum(p.count) from job_positions p where p.job_id = ${jobs.id}), 0)::int`;
      const filled = sql`(select count(*) from assignments a where a.job_id = ${jobs.id} and a.status in ('signed_up', 'billed', 'paid', 'no_show'))::int`;
      const status = sql<string>`case when ${jobs.state} in ('requested', 'declined', 'canceled') then ${jobs.state}::text when ${needed} > 0 and ${filled} >= ${needed} then 'filled' when ${jobs.startAt} < ${now.toISOString()}::timestamptz then 'expired' else 'open' end`;
      const wanted = spec.filters.statuses ?? [];
      // The status filter is applied in SQL so the row limit never drops matching rows.
      const rows = await tx
        .select({ job: jobs, ...jobDims, status })
        .from(jobs)
        .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
        .innerJoin(jobTypes, eq(jobTypes.id, jobs.typeId))
        .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
        .where(
          and(
            gte(jobs.startAt, spec.from),
            lte(jobs.startAt, spec.to),
            ...jobFilters(spec),
            wanted.length > 0 ? sql`${status} in (${sql.join(wanted.map((w) => sql`${w}`), sql`, `)})` : undefined,
          ),
        )
        .orderBy(asc(jobs.startAt), asc(jobs.id))
        .limit(MAX_ROWS + 1);
      return rows.map(({ job, vendorName, typeName, locationName, status: st }) =>
        fact({
          at: job.startAt,
          vendorId: job.vendorId,
          vendorName,
          typeId: job.typeId,
          typeName,
          locationId: job.locationId,
          locationName,
          status: st,
          minutes: minutesBetween(job.startAt, job.endAt),
        }),
      );
    },
  },

  assignments: {
    title: "Assignments",
    groupings: ASSIGNMENT_DIMS,
    measures: ["count", "hours", "cap_hours", "over_under_hours"],
    filters: ALL_FILTERS,
    statuses: assignmentStatus.enumValues,
    load: (tx, spec) => assignmentRows(undefined)(tx, spec),
  },

  cancellations: {
    title: "Cancellations",
    groupings: ASSIGNMENT_DIMS,
    measures: ["count", "hours"],
    filters: ALL_FILTERS,
    statuses: ["canceled", "late_canceled", "removed"],
    load: (tx, spec) => assignmentRows(["canceled", "late_canceled", "removed"])(tx, spec),
  },

  no_shows: {
    title: "No shows",
    groupings: ASSIGNMENT_DIMS,
    measures: ["count", "hours"],
    filters: ALL_FILTERS,
    statuses: ["no_show"],
    load: (tx, spec) => assignmentRows(["no_show"])(tx, spec),
  },

  invoices: {
    title: "Invoices",
    groupings: [...TIME, "deputy", ...JOB_DIMS, "status", "responsible_party", "age_bucket"],
    measures: ["count", "billed_count", "hours", "billed_cents", "paid_cents", "outstanding_cents"],
    filters: ALL_FILTERS,
    statuses: invoiceStatuses,
    // Dated by the detail. `count` is every invoice; billed_count, hours, billed, paid and outstanding cover billed invoices only (not returned or written off).
    async load(tx, spec, now) {
      const rows = await invoiceRows(tx, spec, [gte(jobs.startAt, spec.from), lte(jobs.startAt, spec.to)], now, [asc(jobs.startAt), asc(invoices.number)]);
      return rows.map((r) => r.f);
    },
  },

  payments: {
    title: "Payments",
    groupings: [...TIME, "deputy", ...JOB_DIMS, "status"],
    measures: ["count", "hours", "paid_cents"],
    filters: ALL_FILTERS,
    statuses: invoiceStatuses,
    // Dated by when the person was paid (the deputy's received date, else a coordinator's close).
    async load(tx, spec, now) {
      const rows = await invoiceRows(
        tx,
        spec,
        [sql`${paidAtMs} >= ${spec.from.getTime()}`, sql`${paidAtMs} <= ${spec.to.getTime()}`, inArray(invoices.status, ["sent", "paid"])],
        now,
        [asc(paidAtMs), asc(invoices.number)],
      );
      return rows
        .filter((r) => r.paid)
        .map((r) => ({ ...r.f, at: r.paid!.at, minutes: r.inv.minutes }));
    },
  },

  payment_issues: {
    title: "Payment issues",
    groupings: [...TIME, "deputy", "vendor", "status"],
    measures: ["count", "billed_cents", "outstanding_cents"],
    filters: ["userIds", "vendorIds", "statuses"],
    statuses: paymentIssueStatus.enumValues,
    async load(tx, spec) {
      const rows = await tx
        .select({ issue: paymentIssues, inv: invoices, userName: users.name, vendorName: vendors.name })
        .from(paymentIssues)
        .innerJoin(invoices, eq(invoices.id, paymentIssues.invoiceId))
        .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
        .innerJoin(users, eq(users.id, invoices.payeeUserId))
        .where(
          and(
            gte(paymentIssues.createdAt, spec.from),
            lte(paymentIssues.createdAt, spec.to),
            list(invoices.payeeUserId, spec.filters.userIds),
            list(invoices.vendorId, spec.filters.vendorIds),
            list(paymentIssues.status, spec.filters.statuses),
          ),
        )
        .orderBy(asc(paymentIssues.createdAt), asc(paymentIssues.id))
        .limit(MAX_ROWS + 1);
      // An invoice's amount is billed once, on its earliest issue in the period, however many issues it has.
      const counted = new Set<string>();
      return rows.map(({ issue, inv, userName, vendorName }) => {
        const first = !counted.has(inv.id);
        counted.add(inv.id);
        return fact({
          at: issue.createdAt,
          userId: inv.payeeUserId,
          userName,
          vendorId: inv.vendorId,
          vendorName,
          status: issue.status,
          billed: first ? inv.totalCents : 0,
          outstanding: issue.status === "open" ? inv.totalCents : 0,
        });
      });
    },
  },

  vendor_requests: {
    title: "Vendor requests",
    groupings: [...TIME, "deputy", ...JOB_DIMS, "status"],
    measures: ["count"],
    filters: ALL_FILTERS,
    // New job requests carry the job state; edits to an approved job are change_pending, change_approved or change_declined.
    statuses: [...jobState.enumValues, "change_pending", "change_approved", "change_declined"],
    async load(tx, spec) {
      const wanted = spec.filters.statuses ?? [];
      const jobStatuses = wanted.filter((s) => (jobState.enumValues as readonly string[]).includes(s)) as (typeof jobState.enumValues)[number][];
      const changeStatuses = wanted.filter((s) => s.startsWith("change_")).map((s) => s.slice("change_".length)) as ("pending" | "approved" | "declined")[];
      const out: Fact[] = [];
      if (wanted.length === 0 || jobStatuses.length > 0) {
        const rows = await tx
          .select({ job: jobs, userName: users.name, ...jobDims })
          .from(jobs)
          .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
          .innerJoin(jobTypes, eq(jobTypes.id, jobs.typeId))
          .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
          .innerJoin(users, eq(users.id, jobs.requestedByUserId))
          .where(and(gte(jobs.createdAt, spec.from), lte(jobs.createdAt, spec.to), list(jobs.requestedByUserId, spec.filters.userIds), ...jobFilters(spec), jobStatuses.length > 0 ? inArray(jobs.state, jobStatuses) : undefined))
          .orderBy(asc(jobs.createdAt), asc(jobs.id))
          .limit(MAX_ROWS + 1);
        for (const { job, userName, vendorName, typeName, locationName } of rows) {
          out.push(fact({ at: job.createdAt, userId: job.requestedByUserId, userName, vendorId: job.vendorId, vendorName, typeId: job.typeId, typeName, locationId: job.locationId, locationName, status: job.state }));
        }
      }
      if (wanted.length === 0 || changeStatuses.length > 0) {
        const rows = await tx
          .select({ req: jobChangeRequests, job: jobs, userName: users.name, ...jobDims })
          .from(jobChangeRequests)
          .innerJoin(jobs, eq(jobs.id, jobChangeRequests.jobId))
          .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
          .innerJoin(jobTypes, eq(jobTypes.id, jobs.typeId))
          .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
          .innerJoin(users, eq(users.id, jobChangeRequests.requestedBy))
          .where(and(gte(jobChangeRequests.createdAt, spec.from), lte(jobChangeRequests.createdAt, spec.to), list(jobChangeRequests.requestedBy, spec.filters.userIds), ...jobFilters(spec), changeStatuses.length > 0 ? inArray(jobChangeRequests.status, changeStatuses) : undefined))
          .orderBy(asc(jobChangeRequests.createdAt), asc(jobChangeRequests.id))
          .limit(MAX_ROWS + 1);
        for (const { req, job, userName, vendorName, typeName, locationName } of rows) {
          out.push(fact({ at: req.createdAt, userId: req.requestedBy, userName, vendorId: job.vendorId, vendorName, typeId: job.typeId, typeName, locationId: job.locationId, locationName, status: `change_${req.status}` }));
        }
      }
      return out;
    },
  },

  ops_plans: {
    title: "Ops plans",
    groupings: [...TIME, "vendor", "status"],
    measures: ["count"],
    filters: ["vendorIds", "statuses"],
    statuses: opsPlanStatus.enumValues,
    async load(tx, spec) {
      const rows = await tx
        .select({ plan: opsPlans, vendorName: vendors.name })
        .from(opsPlans)
        .innerJoin(vendors, eq(vendors.id, opsPlans.vendorId))
        .where(and(gte(opsPlans.createdAt, spec.from), lte(opsPlans.createdAt, spec.to), list(opsPlans.vendorId, spec.filters.vendorIds), list(opsPlans.status, spec.filters.statuses)))
        .orderBy(asc(opsPlans.createdAt), asc(opsPlans.id))
        .limit(MAX_ROWS + 1);
      return rows.map(({ plan, vendorName }) => fact({ at: plan.createdAt, vendorId: plan.vendorId, vendorName, status: plan.status }));
    },
  },

  locks_and_overrides: {
    title: "Locks and overrides",
    groupings: [...TIME, "deputy", "vendor", "status"],
    measures: ["count"],
    filters: ["userIds", "vendorIds", "statuses"],
    statuses: ["billing_override", "vendor_hold_active", "vendor_hold_resolved"],
    // Billing lock overrides belong to a person; vendor payment holds belong to a vendor. A person or vendor filter keeps only its own kind.
    async load(tx, spec) {
      const wanted = spec.filters.statuses ?? [];
      const out: Fact[] = [];
      if ((wanted.length === 0 || wanted.includes("billing_override")) && !spec.filters.vendorIds?.length) {
        const rows = await tx
          .select({ o: billingLockOverrides, userName: users.name })
          .from(billingLockOverrides)
          .innerJoin(users, eq(users.id, billingLockOverrides.userId))
          .where(and(gte(billingLockOverrides.createdAt, spec.from), lte(billingLockOverrides.createdAt, spec.to), list(billingLockOverrides.userId, spec.filters.userIds)))
          .orderBy(asc(billingLockOverrides.createdAt), asc(billingLockOverrides.id))
          .limit(MAX_ROWS + 1);
        for (const { o, userName } of rows) out.push(fact({ at: o.createdAt, userId: o.userId, userName, status: "billing_override" }));
      }
      const holdStatuses = wanted.filter((s) => s.startsWith("vendor_hold"));
      if ((wanted.length === 0 || holdStatuses.length > 0) && !spec.filters.userIds?.length) {
        const rows = await tx
          .select({ h: vendorHolds, vendorName: vendors.name })
          .from(vendorHolds)
          .innerJoin(vendors, eq(vendors.id, vendorHolds.vendorId))
          .where(and(gte(vendorHolds.placedAt, spec.from), lte(vendorHolds.placedAt, spec.to), list(vendorHolds.vendorId, spec.filters.vendorIds)))
          .orderBy(asc(vendorHolds.placedAt), asc(vendorHolds.id))
          .limit(MAX_ROWS + 1);
        for (const { h, vendorName } of rows) {
          const status = h.resolvedAt ? "vendor_hold_resolved" : "vendor_hold_active";
          if (wanted.length === 0 || wanted.includes(status)) out.push(fact({ at: h.placedAt, vendorId: h.vendorId, vendorName, status }));
        }
      }
      return out;
    },
  },

  suspensions: {
    title: "Suspensions",
    groupings: [...TIME, "deputy", "status"],
    measures: ["count"],
    filters: ["userIds", "statuses"],
    statuses: ["suspended", "lifted"],
    // Suspension history lives in the audit log; the user row only holds the current suspension.
    async load(tx, spec) {
      const wanted = spec.filters.statuses ?? [];
      const actions = [...(wanted.length === 0 || wanted.includes("suspended") ? ["user.suspend"] : []), ...(wanted.length === 0 || wanted.includes("lifted") ? ["user.suspension_lift"] : [])];
      const rows = await tx
        .select({ at: auditLog.at, action: auditLog.action, userId: users.id, userName: users.name })
        .from(auditLog)
        .innerJoin(users, eq(users.id, auditLog.entityId))
        .where(and(gte(auditLog.at, spec.from), lte(auditLog.at, spec.to), inArray(auditLog.action, actions), eq(auditLog.entityType, "user"), list(users.id, spec.filters.userIds)))
        .orderBy(asc(auditLog.at), asc(auditLog.id))
        .limit(MAX_ROWS + 1);
      return rows.map((r) => fact({ at: r.at, userId: r.userId, userName: r.userName, status: r.action === "user.suspend" ? "suspended" : "lifted" }));
    },
  },

  messages: {
    title: "Messages",
    groupings: [...TIME, "deputy"],
    measures: ["count", "recipients"],
    filters: ["userIds"],
    // Counts and metadata only: the subject and body are never selected.
    async load(tx, spec) {
      const rows = await tx
        .select({ at: messages.sentAt, senderUserId: messages.senderUserId, senderName: users.name, recipientCount: messages.recipientCount })
        .from(messages)
        .leftJoin(users, eq(users.id, messages.senderUserId))
        .where(and(gte(messages.sentAt, spec.from), lte(messages.sentAt, spec.to), list(messages.senderUserId, spec.filters.userIds)))
        .orderBy(asc(messages.sentAt), asc(messages.id))
        .limit(MAX_ROWS + 1);
      return rows.map((r) => fact({ at: r.at, userId: r.senderUserId, userName: r.senderName, status: "sent", recipients: r.recipientCount }));
    },
  },

  audit: {
    title: "Audit log",
    groupings: [...TIME, "deputy", "action", "entity_type"],
    measures: ["count"],
    filters: ["userIds", "statuses"],
    // The status filter is the action name. before, after and reason are never selected.
    async load(tx, spec) {
      const rows = await tx
        .select({ at: auditLog.at, action: auditLog.action, entityType: auditLog.entityType, actorUserId: auditLog.actorUserId, actorName: users.name })
        .from(auditLog)
        .leftJoin(users, eq(users.id, auditLog.actorUserId))
        .where(and(gte(auditLog.at, spec.from), lte(auditLog.at, spec.to), list(auditLog.actorUserId, spec.filters.userIds), list(auditLog.action, spec.filters.statuses)))
        .orderBy(asc(auditLog.at), asc(auditLog.id))
        .limit(MAX_ROWS + 1);
      return rows.map((r) => fact({ at: r.at, userId: r.actorUserId, userName: r.actorName, status: r.action, action: r.action, entityType: r.entityType }));
    },
  },

  activity: {
    title: "Personnel activity",
    groupings: ["deputy"],
    measures: ["details_worked", "hours", "earned_cents", "signups", "gave_away", "late_cancels", "removals", "suspension_removals", "departure_removals", "no_shows", "cancellations", "cancellation_rate"],
    filters: ["userIds", "rankIds", "qualificationIds"],
    // Dated by the detail. Billed and paid count as worked; a canceled detail with no pay does not.
    load: (tx, spec) => activityFacts(tx, spec),
  },
};

/**
 * One row per assignment in the period, classified in SQL: a self-cancel is told apart from the agency releasing a
 * sign-up, and a removal by suspension or by the person leaving the agency from one by a coordinator, by its audit
 * action (older suspension removals by the suspension's marker). Every active ranked person matching the filters gets a `roster` fact so a person
 * with nothing in the period still has a row.
 */
async function activityFacts(tx: Tx, spec: ReportSpec): Promise<Fact[]> {
  const ranks = spec.filters.rankIds ?? [];
  const quals = spec.filters.qualificationIds ?? [];
  const people = and(
    sql`${users.role} <> 'vendor'`,
    list(users.id, spec.filters.userIds),
    list(users.rankId, ranks),
    quals.length > 0
      ? sql`exists (select 1 from ${userQualifications} uq where uq.user_id = ${users.id} and uq.revoked_at is null and uq.qualification_id in (${sql.join(quals.map((q) => sql`${q}`), sql`, `)}))`
      : undefined,
  );
  const kind = sql<ActivityKind>`case
    when ${assignments.status} in ('billed', 'paid') then case when ${invoices.kind} = 'late_cancel' then 'late_cancel' else 'worked' end
    when ${assignments.status} = 'late_canceled' then 'late_cancel'
    when ${assignments.status} = 'no_show' then 'no_show'
    when ${assignments.status} = 'removed' and exists (select 1 from audit_log al where al.entity_type = 'assignment' and al.entity_id = ${assignments.id} and al.action = ${DEPARTURE_REMOVE_ACTION}) then 'departure_removed'
    when ${assignments.status} = 'removed' then case when exists (select 1 from audit_log al where al.entity_type = 'assignment' and al.entity_id = ${assignments.id}
      and (al.action = ${SUSPENSION_REMOVE_ACTION} or (al.action = 'assignment.remove' and al.reason like ${`${SUSPENSION_REMOVAL_REASON}: %`} and ${assignments.removalReason} = ${SUSPENSION_REMOVAL_REASON})))
      then 'suspension_removed' else 'removed' end
    when ${assignments.status} = 'canceled' then case when exists (select 1 from audit_log al where al.entity_type = 'assignment' and al.entity_id = ${assignments.id} and al.action = ${GAVE_AWAY_ACTION}) then 'gave_away' else 'canceled' end
    else 'open' end`;
  const rows = await tx
    .select({ a: assignments, job: jobs, userName: users.name, kind, invStatus: invoices.status, invTotal: invoices.totalCents })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(users, eq(users.id, assignments.userId))
    .leftJoin(invoices, eq(invoices.assignmentId, assignments.id))
    .where(and(gte(jobs.startAt, spec.from), lte(jobs.startAt, spec.to), people))
    .orderBy(asc(jobs.startAt), asc(assignments.id))
    .limit(MAX_ROWS + 1);
  const roster = await tx
    .select({ id: users.id, name: users.name })
    .from(users)
    .where(and(eq(users.active, true), sql`${users.rankId} is not null`, people))
    .orderBy(asc(users.name), asc(users.id))
    .limit(MAX_ROWS + 1);
  const out: Fact[] = rows.map(({ a, job, userName, kind: k, invStatus, invTotal }) => {
    const worked = k === "worked";
    const minutes = worked ? minutesBetween(a.actualStartAt ?? a.plannedStartAt ?? job.startAt, a.actualEndAt ?? a.plannedEndAt ?? job.endAt) : 0;
    return fact({ at: job.startAt, userId: a.userId, userName, status: a.status, minutes, activity: k, earned: invStatus && isBilled(invStatus) ? (invTotal ?? 0) : 0 });
  });
  for (const p of roster) out.push(fact({ at: spec.from, userId: p.id, userName: p.name, status: "roster", activity: "roster" }));
  return out;
}

export { ageBucket };
