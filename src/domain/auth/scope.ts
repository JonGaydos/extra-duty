import { and, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, jobChangeRequests, jobPositions, jobs } from "@/db/schema";

const open = eq(jobs.confidential, false);

/**
 * The vendor a record belongs to, for the policy's vendor-scoped checks (a vendor manager may act on their vendors'
 * details only). Undefined when the record does not exist: the check then refuses a deputy, and staff go on to the
 * service's own not-found answer. A confidential detail has no vendor here either: a vendor manager never acts on one
 * (owner decision 2026-11-27), and staff do not need the vendor.
 */
export async function jobVendorId(tx: Tx, jobId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(jobs).where(and(eq(jobs.id, jobId), open));
  return row?.vendorId;
}

export async function positionVendorId(tx: Tx, jobPositionId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(jobPositions).innerJoin(jobs, eq(jobs.id, jobPositions.jobId)).where(and(eq(jobPositions.id, jobPositionId), open));
  return row?.vendorId;
}

export async function assignmentVendorId(tx: Tx, assignmentId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(assignments).innerJoin(jobs, eq(jobs.id, assignments.jobId)).where(and(eq(assignments.id, assignmentId), open));
  return row?.vendorId;
}

export async function changeRequestVendorId(tx: Tx, requestId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(jobChangeRequests).innerJoin(jobs, eq(jobs.id, jobChangeRequests.jobId)).where(and(eq(jobChangeRequests.id, requestId), open));
  return row?.vendorId;
}
