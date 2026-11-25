import { asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoices, jobPositions, jobs, vendors, type assignmentStatus, type invoiceStatus } from "@/db/schema";
import { NotFoundError, ValidationError } from "../errors";
import { isReleased, type JobState } from "../release/release";

export type JobDisplayStatus =
  | "requested"
  | "scheduled"
  | "open"
  | "filled"
  | "ready_to_bill"
  | "billed"
  | "closed"
  | "expired"
  | "canceled"
  | "declined"
  | "on_hold";

export type StatusJob = {
  state: JobState;
  held: boolean;
  releaseAt: Date | null;
  startAt: Date;
  endAt: Date;
  vendorOnPaymentHold: boolean;
  /** Total spots across every position. */
  spots: number;
};

export type StatusAssignment = { id: string; status: (typeof assignmentStatus.enumValues)[number] };
export type StatusInvoice = { assignmentId: string; status: (typeof invoiceStatus.enumValues)[number] };

/** People who held a spot and worked (or were due to work) the detail. */
const WORKED = new Set<StatusAssignment["status"]>(["signed_up", "billed", "paid"]);

export function deriveJobStatus(
  job: StatusJob,
  assignments: StatusAssignment[],
  invoices: StatusInvoice[],
  now: Date,
): JobDisplayStatus {
  if (job.state === "canceled") return "canceled";
  if (job.state === "declined") return "declined";
  if (job.state === "requested") return "requested";
  const t = now.getTime();
  const started = t >= job.startAt.getTime();
  if (job.vendorOnPaymentHold && !started) return "on_hold";
  const released = isReleased(job, now);
  if (!released && !started) return "scheduled";

  const staff = assignments.filter((a) => WORKED.has(a.status));
  const free = job.spots - assignments.filter((a) => a.status === "signed_up").length > 0;

  if (t >= job.endAt.getTime() && staff.length > 0) {
    const byAssignment = new Map(invoices.map((i) => [i.assignmentId, i.status]));
    const statuses = staff.map((a) => byAssignment.get(a.id));
    if (statuses.some((s) => s === undefined)) return "ready_to_bill";
    return statuses.every((s) => s === "paid" || s === "written_off") ? "closed" : "billed";
  }
  if (started && free) return "expired";
  return free ? "open" : "filled";
}

/** A detail's status (spec section 9) from what is stored: its sign-ups, their invoices (latest per sign-up) and the vendor's hold. */
export async function loadJobStatus(tx: Tx, jobId: string, now: Date): Promise<JobDisplayStatus> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new NotFoundError("Job not found.");
  const [vendor] = await tx.select({ paymentHold: vendors.paymentHold }).from(vendors).where(eq(vendors.id, job.vendorId));
  const spots = (await tx.select({ count: jobPositions.count }).from(jobPositions).where(eq(jobPositions.jobId, jobId))).reduce((n, p) => n + p.count, 0);
  const rows = await tx.select({ id: assignments.id, status: assignments.status }).from(assignments).where(eq(assignments.jobId, jobId));
  const invs = rows.length
    ? await tx
        .select({ assignmentId: invoices.assignmentId, status: invoices.status })
        .from(invoices)
        .where(inArray(invoices.assignmentId, rows.map((r) => r.id)))
        .orderBy(asc(invoices.createdAt), asc(invoices.id))
    : [];
  return deriveJobStatus({ ...job, vendorOnPaymentHold: vendor?.paymentHold ?? false, spots }, rows, invs, now);
}

const QUARTER_MS = 15 * 60_000;

export type FlexJob = {
  startAt: Date;
  endAt: Date;
  flexEarliestStartAt: Date | null;
  flexLatestEndAt: Date | null;
  flexAllowShorter: boolean;
};

/** Throws ValidationError when the planned times are not allowed; `shorter` says the plan is under the default length. */
export function validatePlannedTimes(job: FlexJob, planned: { startAt: Date; endAt: Date }): { shorter: boolean } {
  const s = planned.startAt.getTime();
  const e = planned.endAt.getTime();
  if (Number.isNaN(s) || Number.isNaN(e)) throw new ValidationError("Planned start and end times are required.");
  if (e <= s) throw new ValidationError("The planned end must be after the planned start.");
  const flex = job.flexEarliestStartAt !== null && job.flexLatestEndAt !== null;
  if (!flex) {
    if (s !== job.startAt.getTime() || e !== job.endAt.getTime()) {
      throw new ValidationError("This detail has fixed times.");
    }
    return { shorter: false };
  }
  if (s % QUARTER_MS !== 0 || e % QUARTER_MS !== 0) {
    throw new ValidationError("Planned times must fall on 15-minute marks.");
  }
  if (s < job.flexEarliestStartAt!.getTime() || e > job.flexLatestEndAt!.getTime()) {
    throw new ValidationError("Planned times must fall inside the flexible window.");
  }
  const full = job.endAt.getTime() - job.startAt.getTime();
  const length = e - s;
  if (length > full) throw new ValidationError("The planned shift cannot be longer than the detail.");
  if (length < full) {
    if (!job.flexAllowShorter) throw new ValidationError("This detail does not allow a shorter shift.");
    return { shorter: true };
  }
  return { shorter: false };
}
