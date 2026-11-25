import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoices, jobPositions, jobs, positionTypes, users, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { loadUnbilledWhere } from "../billing/lock";
import { NotFoundError, ValidationError } from "../errors";
import { formatInvoiceNumber } from "../invoices/invoices";
import { getSettings } from "../settings/settings";
import { agencyDateOnly, agencyDayKey } from "../time/agency-time";
import type { Cents } from "../types";

/**
 * What someone leaving the agency leaves behind: sign-ups on details after their last day, worked details not yet
 * billed, and invoices vendors still owe them. These are plain reads; deactivateUser in users.ts acts on them.
 */

/** A sign-up that is still holding a spot or a place in line. */
const HOLDING = ["signed_up", "backup", "pending_short"] as const;
/** Invoices a vendor still owes on: everything but paid, written off and returned (a returned one is unbilled work again). */
const UNPAID = ["pending_review", "ready_to_send", "sent", "approved_unsent"] as const;

export type DepartureSignup = {
  assignmentId: string;
  status: (typeof HOLDING)[number];
  jobId: string;
  jobNumber: number;
  title: string;
  vendorName: string;
  position: string;
  startAt: Date;
  endAt: Date;
};

export type DepartureUnbilled = {
  assignmentId: string;
  userId: string;
  jobId: string;
  jobNumber: number;
  title: string;
  vendorName: string;
  startAt: Date;
  endAt: Date;
  lateCancel: boolean;
};

export type DepartureInvoice = {
  invoiceId: string;
  number: string;
  jobId: string;
  jobNumber: number;
  title: string;
  vendorName: string;
  status: (typeof UNPAID)[number];
  totalCents: Cents;
};

export type DepartureChecklist = { upcoming: DepartureSignup[]; unbilled: DepartureUnbilled[]; unpaid: DepartureInvoice[] };

/**
 * The last day as an agency date (YYYY-MM-DD), today or earlier, and the instant its next day starts: a detail
 * starting at or after `after` is after the last day.
 */
export function parseLastDay(value: unknown, now: Date): { key: string; after: Date } {
  const key = typeof value === "string" ? value.trim() : "";
  if (!key) throw new ValidationError("Enter their last day.");
  const end = agencyDateOnly(key, "end");
  if (!end) throw new ValidationError("Enter the last day as a date.");
  if (key > agencyDayKey(now)) throw new ValidationError("The last day cannot be in the future.");
  return { key, after: new Date(end.getTime() + 1) };
}

/**
 * The person's sign-ups that leaving removes, soonest first: on details that start after the last day and have not
 * started yet (as a suspension does). A detail already worked or under way stays: it is billable work.
 */
export async function signupsAfter(tx: Tx, userId: string, after: Date, now: Date): Promise<DepartureSignup[]> {
  const from = after.getTime() > now.getTime() ? after : new Date(now.getTime() + 1);
  const rows = await tx
    .select({ a: assignments, job: jobs, vendorName: vendors.name, position: positionTypes.name })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(and(eq(assignments.userId, userId), inArray(assignments.status, [...HOLDING]), gte(jobs.startAt, from)))
    .orderBy(asc(jobs.startAt), asc(assignments.id));
  return rows.map(({ a, job, vendorName, position }) => ({
    assignmentId: a.id,
    status: a.status as DepartureSignup["status"],
    jobId: job.id,
    jobNumber: job.number,
    title: job.title,
    vendorName,
    position,
    startAt: job.startAt,
    endAt: job.endAt,
  }));
}

/** Worked details (and late cancels past their end) waiting for an invoice, for the people matching `where`. */
async function unbilledFor(tx: Tx, where: Parameters<typeof loadUnbilledWhere>[1], now: Date): Promise<DepartureUnbilled[]> {
  const items = await loadUnbilledWhere(tx, where, now);
  if (items.length === 0) return [];
  const extra = new Map(
    (
      await tx
        .select({ id: assignments.id, status: assignments.status, startAt: jobs.startAt, vendorName: vendors.name })
        .from(assignments)
        .innerJoin(jobs, eq(jobs.id, assignments.jobId))
        .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
        .where(inArray(assignments.id, items.map((i) => i.assignmentId)))
    ).map((r) => [r.id, r]),
  );
  return items.map((i) => {
    const x = extra.get(i.assignmentId)!;
    return { assignmentId: i.assignmentId, userId: i.userId, jobId: i.jobId, jobNumber: i.jobNumber, title: i.title, vendorName: x.vendorName, startAt: x.startAt, endAt: i.endAt, lateCancel: x.status === "late_canceled" };
  });
}

/** The person's work that is ready to bill and has no invoice, oldest first. */
export function unbilledWork(tx: Tx, userId: string, now: Date): Promise<DepartureUnbilled[]> {
  return unbilledFor(tx, eq(assignments.userId, userId), now);
}

/** The person's invoices that are not paid or closed, oldest first. */
export async function unpaidInvoices(tx: Tx, userId: string): Promise<DepartureInvoice[]> {
  const { invoiceNumberPrefix } = await getSettings(tx);
  const rows = await tx
    .select({ inv: invoices, job: jobs, vendorName: vendors.name })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(and(eq(invoices.payeeUserId, userId), inArray(invoices.status, [...UNPAID])))
    .orderBy(asc(invoices.number));
  return rows.map(({ inv, job, vendorName }) => ({
    invoiceId: inv.id,
    number: formatInvoiceNumber(invoiceNumberPrefix, inv.number),
    jobId: job.id,
    jobNumber: job.number,
    title: job.title,
    vendorName,
    status: inv.status as DepartureInvoice["status"],
    totalCents: inv.totalCents,
  }));
}

/** Unbilled work of everyone who left (turned-off staff accounts), for the coordinators' to-do list. */
export async function departedUnbilled(tx: Tx, now: Date): Promise<Array<DepartureUnbilled & { name: string }>> {
  const gone = sql`${assignments.userId} in (select id from users where active = false and role <> 'vendor')`;
  const items = await unbilledFor(tx, gone, now);
  if (items.length === 0) return [];
  const names = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, [...new Set(items.map((i) => i.userId))]))).map((u) => [u.id, u.name]));
  return items.map((i) => ({ ...i, name: names.get(i.userId) ?? "" })).sort((a, b) => a.name.localeCompare(b.name) || a.endAt.getTime() - b.endAt.getTime());
}

/**
 * Staff write off a worked detail of someone who left that will never be billed. It leaves every to-bill list and
 * can no longer be billed. The reason is required and audited.
 */
export async function writeOffDetail(actor: Actor, tx: Tx, assignmentId: string, reason: string, now: Date = new Date()): Promise<void> {
  assertCan(actor, "assignment.writeOff");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new ValidationError("A reason is required.");
  const [before] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId)).for("update");
  if (!before) throw new NotFoundError("Assignment not found.");
  const [owner] = await tx.select({ active: users.active }).from(users).where(eq(users.id, before.userId));
  if (owner?.active) throw new ValidationError("Only a detail of someone who left the agency can be written off.");
  const [waiting] = await loadUnbilledWhere(tx, eq(assignments.id, assignmentId), now);
  if (!waiting) throw new ValidationError("This detail is not waiting to be billed.");
  const [after] = await tx.update(assignments).set({ writtenOffAt: now, writtenOffBy: actor.userId, writeOffReason: why, updatedAt: now }).where(eq(assignments.id, assignmentId)).returning();
  await recordAudit(tx, { actor, action: "assignment.write_off", entityType: "assignment", entityId: assignmentId, before, after, reason: why });
}
