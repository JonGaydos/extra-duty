import { and, asc, eq, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoices, jobs, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assertCan } from "@/domain/auth/policy";
import { NotFoundError } from "@/domain/errors";
import { agencyDateParts } from "@/domain/time/agency-time";
import type { Cents, Minutes } from "@/domain/types";

export type Totals = { details: number; minutes: Minutes; billedCents: Cents; paidCents: Cents };

export type PaidDateSource = "deputy" | "coordinator_close";

type InvoiceStatus = (typeof invoices.$inferSelect)["status"];

/** Epoch-millisecond expression for when a coordinator closed the invoice as paid (null if never). */
export const closedPaidAtMs: SQL<number | null> = sql`(select (extract(epoch from max(e.at)) * 1000)::bigint from invoice_events e where e.invoice_id = ${invoices.id} and e.event = 'closed_paid')`;

export const fromMs = (v: unknown): Date | null => (v === null || v === undefined ? null : new Date(Number(v)));

/** Billed totals count pending review, ready to send, sent and paid. Returned and written off invoices never count. */
export const isBilled = (status: InvoiceStatus): boolean => status === "pending_review" || status === "ready_to_send" || status === "approved_unsent" || status === "sent" || status === "paid";

/**
 * When the person was paid: the date the deputy marked it received; for an invoice a coordinator
 * closed as paid without one, the close time. Written off and returned invoices are never paid.
 */
export function paidDate(inv: { status: InvoiceStatus; deputyPaidAt: Date | null; closedPaidAt: Date | null }): { at: Date; source: PaidDateSource } | null {
  if (inv.status === "written_off" || inv.status === "returned") return null;
  if (inv.deputyPaidAt) return { at: inv.deputyPaidAt, source: "deputy" };
  if (inv.status === "paid") {
    if (inv.closedPaidAt) return { at: inv.closedPaidAt, source: "coordinator_close" };
    // No path writes this today. Never guess a date (it would move income between tax years): leave it unpaid and say so.
    console.warn("report: invoice is paid but has no paid date or close event; treated as unpaid");
  }
  return null;
}

export type UserInvoiceRow = {
  invoiceId: string;
  number: number;
  status: InvoiceStatus;
  minutes: Minutes;
  totalCents: Cents;
  jobNumber: number;
  jobTitle: string;
  jobStartAt: Date;
  vendorId: string;
  vendorName: string;
  deputyPaidAt: Date | null;
  vendorPaidAt: Date | null;
  paid: { at: Date; source: PaidDateSource } | null;
};

/** Own data for personnel; coordinators and admins may read anyone's. */
export async function loadUserInvoices(actor: Actor, tx: Tx, userId: string, extra?: SQL): Promise<{ user: typeof users.$inferSelect; rows: UserInvoiceRow[] }> {
  assertCan(actor, "earnings.read", { ownerUserId: userId });
  const [user] = await tx.select().from(users).where(eq(users.id, userId));
  if (!user) throw new NotFoundError("Person not found.");
  const rows = await tx
    .select({ inv: invoices, job: jobs, vendorName: vendors.name, closedPaidAt: closedPaidAtMs.mapWith(fromMs) })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(and(eq(invoices.payeeUserId, userId), extra))
    .orderBy(asc(jobs.startAt), asc(invoices.number));
  return {
    user,
    rows: rows.map(({ inv, job, vendorName, closedPaidAt }) => ({
      invoiceId: inv.id,
      number: inv.number,
      status: inv.status,
      minutes: inv.minutes,
      totalCents: inv.totalCents,
      jobNumber: job.number,
      jobTitle: job.title,
      jobStartAt: job.startAt,
      vendorId: inv.vendorId,
      vendorName,
      deputyPaidAt: inv.deputyPaidAt,
      vendorPaidAt: inv.vendorPaidAt,
      paid: paidDate({ status: inv.status, deputyPaidAt: inv.deputyPaidAt, closedPaidAt }),
    })),
  };
}

const empty = (): Totals => ({ details: 0, minutes: 0, billedCents: 0, paidCents: 0 });

/**
 * Billed totals use the detail's agency date; paid totals use the paid date (`paidDate`).
 * Outstanding is everything billed and not yet paid, whatever its date.
 */
export async function earningsDashboard(
  actor: Actor,
  tx: Tx,
  userId: string,
  now: Date = new Date(),
): Promise<{ thisMonth: Totals; thisYear: Totals; outstandingCents: Cents; byYear: Array<{ year: number } & Totals> }> {
  const { rows } = await loadUserInvoices(actor, tx, userId);
  const here = agencyDateParts(now);
  const thisMonth = empty();
  const thisYear = empty();
  const years = new Map<number, Totals>();
  let outstandingCents = 0;
  const year = (y: number) => {
    let t = years.get(y);
    if (!t) years.set(y, (t = empty()));
    return t;
  };

  for (const r of rows) {
    if (isBilled(r.status)) {
      const d = agencyDateParts(r.jobStartAt);
      const targets = [year(d.year)];
      if (d.year === here.year) targets.push(thisYear);
      if (d.year === here.year && d.month === here.month) targets.push(thisMonth);
      for (const t of targets) {
        t.details += 1;
        t.minutes += r.minutes;
        t.billedCents += r.totalCents;
      }
      if (!r.paid) outstandingCents += r.totalCents;
    }
    if (r.paid) {
      const p = agencyDateParts(r.paid.at);
      year(p.year).paidCents += r.totalCents;
      if (p.year === here.year) thisYear.paidCents += r.totalCents;
      if (p.year === here.year && p.month === here.month) thisMonth.paidCents += r.totalCents;
    }
  }
  const byYear = [...years.entries()].sort(([a], [b]) => b - a).map(([y, t]) => ({ year: y, ...t }));
  return { thisMonth, thisYear, outstandingCents, byYear };
}
