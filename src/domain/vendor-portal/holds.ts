import { and, asc, desc, eq, gt, inArray, isNull, lte } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobs, vendorHolds, vendors } from "@/db/schema";

export type Job = typeof jobs.$inferSelect;
export type VendorHold = typeof vendorHolds.$inferSelect;

const OPEN_STATES = ["requested", "scheduled", "active"] as const;
const DAY_MS = 86_400_000;

/** The vendor's unresolved hold, if any. */
export async function openHold(tx: Tx, vendorId: string): Promise<VendorHold | null> {
  const [row] = await tx
    .select()
    .from(vendorHolds)
    .where(and(eq(vendorHolds.vendorId, vendorId), isNull(vendorHolds.resolvedAt)))
    .orderBy(desc(vendorHolds.placedAt))
    .limit(1);
  return row ?? null;
}

/**
 * A job is locked while its vendor has an open hold, the job is not canceled or declined, and it starts after
 * the hold was placed: work done before the hold stays billable.
 */
export async function isJobLocked(tx: Tx, jobId: string): Promise<boolean> {
  const [row] = await tx.select({ state: jobs.state, vendorId: jobs.vendorId, startAt: jobs.startAt }).from(jobs).where(eq(jobs.id, jobId));
  if (!row || !(OPEN_STATES as readonly string[]).includes(row.state)) return false;
  const hold = await openHold(tx, row.vendorId);
  return !!hold && row.startAt.getTime() > hold.placedAt.getTime();
}

export type LockedDetail = Job & { vendorName: string; holdPlacedAt: Date };

/**
 * Locked details for the coordinators' to-do list: `started` need action (cancel), `startingSoon`
 * (within 24 hours) are a heads-up. Reads only; nothing is canceled here.
 */
export async function lockedDetailsForTodo(tx: Tx, now: Date): Promise<{ started: LockedDetail[]; startingSoon: LockedDetail[] }> {
  const rows = await tx
    .select({ job: jobs, vendorName: vendors.name, holdPlacedAt: vendorHolds.placedAt })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .innerJoin(vendorHolds, and(eq(vendorHolds.vendorId, jobs.vendorId), isNull(vendorHolds.resolvedAt)))
    .where(and(inArray(jobs.state, ["scheduled", "active"]), gt(jobs.startAt, vendorHolds.placedAt), lte(jobs.startAt, new Date(now.getTime() + DAY_MS))))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
  const out = { started: [] as LockedDetail[], startingSoon: [] as LockedDetail[] };
  for (const { job, vendorName, holdPlacedAt } of rows) {
    (job.startAt.getTime() <= now.getTime() ? out.started : out.startingSoon).push({ ...job, vendorName, holdPlacedAt });
  }
  return out;
}

/** Open jobs of a vendor starting after `startAfter` and ending after `endAfter`: the ones a hold locks or unlocks. */
export async function currentJobsOf(tx: Tx, vendorId: string, startAfter: Date, endAfter: Date): Promise<Job[]> {
  return tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.vendorId, vendorId), inArray(jobs.state, ["scheduled", "active"]), gt(jobs.startAt, startAfter), gt(jobs.endAt, endAfter)))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
}
