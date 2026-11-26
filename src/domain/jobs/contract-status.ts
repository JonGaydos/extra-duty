import { and, asc, eq, gt, gte, inArray, notInArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobAttachments, jobs, vendorDocuments, vendors } from "@/db/schema";
import { NotFoundError } from "../errors";
import { agencyDayKey } from "../time/agency-time";
import { vendorHasCurrentContract } from "../vendors/vendors";

export type ContractStatus = "vendor" | "detail" | "missing";

/** How far back "recent" reaches for the missing-contract to-do list. */
const RECENT_CONTRACT_DAYS = 30;

async function statusFor(tx: Tx, job: { id: string; vendorId: string; startAt: Date }): Promise<ContractStatus> {
  if (await vendorHasCurrentContract(tx, job.vendorId, agencyDayKey(job.startAt))) return "vendor";
  const [att] = await tx
    .select({ id: jobAttachments.id })
    .from(jobAttachments)
    .where(and(eq(jobAttachments.jobId, job.id), eq(jobAttachments.isContract, true)))
    .limit(1);
  return att ? "detail" : "missing";
}

/** Advisory only: a missing contract never blocks anything. */
export async function jobContractStatus(tx: Tx, jobId: string): Promise<ContractStatus> {
  const [job] = await tx.select({ id: jobs.id, vendorId: jobs.vendorId, startAt: jobs.startAt }).from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new NotFoundError("Job not found.");
  return statusFor(tx, job);
}

export type MissingContractJob = { id: string; number: number; title: string; vendorId: string; startAt: Date };

/** Upcoming and recent (last 30 days) jobs that are not canceled or declined and have no contract. */
export async function detailsMissingContract(tx: Tx, now: Date): Promise<MissingContractJob[]> {
  const since = new Date(now.getTime() - RECENT_CONTRACT_DAYS * 86_400_000);
  const rows = await tx
    .select({ id: jobs.id, number: jobs.number, title: jobs.title, vendorId: jobs.vendorId, startAt: jobs.startAt })
    .from(jobs)
    .where(and(gte(jobs.startAt, since), notInArray(jobs.state, ["canceled", "declined"])))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
  const out: MissingContractJob[] = [];
  // Sequential: these queries share one transaction's connection, which runs one at a time.
  for (const j of rows) if ((await statusFor(tx, j)) === "missing") out.push(j);
  return out;
}

/**
 * Details that have not ended (and are not canceled or declined) with no contract: neither one of the vendor's
 * contract documents in force on the detail's agency date nor a contract attached to the detail. Three queries,
 * whatever the number of details. Soonest first, with the vendor's name.
 */
export async function upcomingMissingContract(tx: Tx, now: Date): Promise<Array<MissingContractJob & { vendorName: string }>> {
  const rows = await tx
    .select({ id: jobs.id, number: jobs.number, title: jobs.title, vendorId: jobs.vendorId, startAt: jobs.startAt, vendorName: vendors.name })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(and(gt(jobs.endAt, now), notInArray(jobs.state, ["canceled", "declined"])))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
  if (rows.length === 0) return [];
  const docs = await tx
    .select({ vendorId: vendorDocuments.vendorId, signedOn: vendorDocuments.signedOn, expiresOn: vendorDocuments.expiresOn })
    .from(vendorDocuments)
    .where(and(eq(vendorDocuments.kind, "contract"), inArray(vendorDocuments.vendorId, [...new Set(rows.map((r) => r.vendorId))])));
  const attached = new Set(
    (
      await tx
        .select({ jobId: jobAttachments.jobId })
        .from(jobAttachments)
        .where(and(eq(jobAttachments.isContract, true), inArray(jobAttachments.jobId, rows.map((r) => r.id))))
    ).map((a) => a.jobId),
  );
  return rows.filter((r) => {
    if (attached.has(r.id)) return false;
    const day = agencyDayKey(r.startAt);
    // As vendorHasCurrentContract: signed by then (or undated) and not expired.
    return !docs.some((d) => d.vendorId === r.vendorId && (!d.signedOn || d.signedOn <= day) && (!d.expiresOn || d.expiresOn >= day));
  });
}
