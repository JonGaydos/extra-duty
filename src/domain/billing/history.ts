import { and, asc, eq, gte, lte, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoices, jobs, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError } from "@/domain/errors";
import { formatInvoiceNumber } from "@/domain/invoices/invoices";
import { getSettings } from "@/domain/settings/settings";
import { agencyDayKey, agencyMonthKey } from "@/domain/time/agency-time";
import type { Cents, Minutes } from "@/domain/types";
import { centsText, toCsv } from "@/lib/csv";

export type HistoryFilter = {
  /** Inclusive bounds on the job's start. */
  from?: Date;
  to?: Date;
  vendorId?: string;
  /** Coordinators and admins only; personnel always see their own. */
  payeeUserId?: string;
};

export type HistoryRow = {
  invoiceId: string;
  number: number;
  payeeUserId: string;
  payeeName: string;
  jobNumber: number;
  jobTitle: string;
  vendorId: string;
  vendorName: string;
  jobStartAt: Date;
  minutes: Minutes;
  rateCents: Cents;
  totalCents: Cents;
  status: (typeof invoices.$inferSelect)["status"];
  deputyPaidAt: Date | null;
  vendorPaidAt: Date | null;
  reference: string | null;
};

export type BillingHistory = {
  /** `count` and `minutes` cover the invoices that count as earned (pending review, sent and paid). */
  totals: { count: number; minutes: Minutes; earnedCents: Cents; paidCents: Cents; waitingCents: Cents };
  byMonth: Array<{ month: string; earnedCents: Cents }>;
  rows: HistoryRow[];
};

async function loadRows(actor: Actor, tx: Tx, filter: HistoryFilter): Promise<HistoryRow[]> {
  if (actor.role === "vendor") throw new ForbiddenError();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  if (!staff && filter.payeeUserId !== undefined && filter.payeeUserId !== actor.userId) throw new ForbiddenError();
  const payee = staff ? filter.payeeUserId : actor.userId;

  const where: SQL[] = [];
  if (payee) where.push(eq(invoices.payeeUserId, payee));
  if (filter.vendorId) where.push(eq(invoices.vendorId, filter.vendorId));
  if (filter.from) where.push(gte(jobs.startAt, filter.from));
  if (filter.to) where.push(lte(jobs.startAt, filter.to));

  const rows = await tx
    .select({ inv: invoices, job: jobs, vendorName: vendors.name, payeeName: users.name })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .where(and(...where))
    .orderBy(asc(jobs.startAt), asc(invoices.number));
  return rows.map(({ inv, job, vendorName, payeeName }) => ({
    invoiceId: inv.id,
    number: inv.number,
    payeeUserId: inv.payeeUserId,
    payeeName,
    jobNumber: job.number,
    jobTitle: job.title,
    vendorId: inv.vendorId,
    vendorName,
    jobStartAt: job.startAt,
    minutes: inv.minutes,
    rateCents: inv.rateCents,
    totalCents: inv.totalCents,
    status: inv.status,
    deputyPaidAt: inv.deputyPaidAt,
    vendorPaidAt: inv.vendorPaidAt,
    reference: inv.deputyReference ?? inv.vendorPaidReference,
  }));
}

/** Invoices the payee has earned or is owed. Written off and returned invoices are listed but never counted. */
export async function billingHistory(actor: Actor, tx: Tx, filter: HistoryFilter = {}): Promise<BillingHistory> {
  const rows = await loadRows(actor, tx, filter);
  const totals = { count: 0, minutes: 0, earnedCents: 0, paidCents: 0, waitingCents: 0 };
  const months = new Map<string, number>();
  for (const r of rows) {
    if (r.status === "written_off" || r.status === "returned") continue;
    totals.count += 1;
    totals.minutes += r.minutes;
    totals.earnedCents += r.totalCents;
    if (r.status === "paid") totals.paidCents += r.totalCents;
    else totals.waitingCents += r.totalCents;
    const month = agencyMonthKey(r.jobStartAt);
    months.set(month, (months.get(month) ?? 0) + r.totalCents);
  }
  const byMonth = [...months.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([month, earnedCents]) => ({ month, earnedCents }));
  return { totals, byMonth, rows };
}

const HEADER = ["Invoice", "Job", "Vendor", "Job date", "Minutes", "Rate", "Total", "Status", "Deputy paid", "Vendor paid", "Reference"];

export async function exportBillingCsv(actor: Actor, tx: Tx, filter: HistoryFilter = {}): Promise<string> {
  const rows = await loadRows(actor, tx, filter);
  const { invoiceNumberPrefix } = await getSettings(tx);
  const lines = rows.map((r) => [
    formatInvoiceNumber(invoiceNumberPrefix, r.number),
    String(r.jobNumber),
    r.vendorName,
    agencyDayKey(r.jobStartAt),
    String(r.minutes),
    centsText(r.rateCents),
    centsText(r.totalCents),
    r.status,
    r.deputyPaidAt ? agencyDayKey(r.deputyPaidAt) : "",
    r.vendorPaidAt ? agencyDayKey(r.vendorPaidAt) : "",
    r.reference ?? "",
  ]);
  return toCsv(HEADER, lines);
}
