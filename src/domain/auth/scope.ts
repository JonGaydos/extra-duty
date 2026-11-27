import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, jobChangeRequests, jobPositions, jobs } from "@/db/schema";

/**
 * The vendor a record belongs to, for the policy's vendor-scoped checks (a vendor manager may act on their vendors'
 * details only). Undefined when the record does not exist: the check then refuses a deputy, and staff go on to the
 * service's own not-found answer.
 */

export async function jobVendorId(tx: Tx, jobId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(jobs).where(eq(jobs.id, jobId));
  return row?.vendorId;
}

export async function positionVendorId(tx: Tx, jobPositionId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(jobPositions).innerJoin(jobs, eq(jobs.id, jobPositions.jobId)).where(eq(jobPositions.id, jobPositionId));
  return row?.vendorId;
}

export async function assignmentVendorId(tx: Tx, assignmentId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(assignments).innerJoin(jobs, eq(jobs.id, assignments.jobId)).where(eq(assignments.id, assignmentId));
  return row?.vendorId;
}

export async function changeRequestVendorId(tx: Tx, requestId: string): Promise<string | undefined> {
  const [row] = await tx.select({ vendorId: jobs.vendorId }).from(jobChangeRequests).innerJoin(jobs, eq(jobs.id, jobChangeRequests.jobId)).where(eq(jobChangeRequests.id, requestId));
  return row?.vendorId;
}
