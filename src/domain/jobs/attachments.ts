import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobAttachments, jobs } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";
import { readStoredFile, uploadFile, type FileRow } from "../files/files";
import { cleanUrl } from "../vendors/vendors";
import { getJob, type JobAttachment } from "./jobs";

export type ContractAttachmentInput = {
  label: string;
  file?: { body: Buffer; filename: string; contentType: string };
  url?: string;
};

/**
 * Coordinators and admins attach a contract to one detail (a detail-only contract, when the vendor has none on file
 * for that date). Exactly one of a file or an https link. Audited.
 */
export async function attachContractToJob(actor: Actor, tx: Tx, jobId: string, input: ContractAttachmentInput): Promise<JobAttachment> {
  const [job] = await tx.select({ id: jobs.id, vendorId: jobs.vendorId }).from(jobs).where(eq(jobs.id, jobId));
  assertCan(actor, "job.update", { vendorId: job?.vendorId });
  if (!job) throw new NotFoundError("Job not found.");
  const label = typeof input.label === "string" ? input.label.trim() : "";
  if (!label) throw new ValidationError("A label is required.");
  const hasUrl = typeof input.url === "string" && input.url.trim() !== "";
  if (Boolean(input.file) === hasUrl) throw new ValidationError("Provide either a file or a link, not both and not neither.");
  let fileId: string | null = null;
  let url: string | null = null;
  if (input.file) fileId = (await uploadFile(actor, tx, { kind: "contract", ...input.file })).id;
  else url = cleanUrl(input.url!);
  const [row] = await tx.insert(jobAttachments).values({ jobId, label, fileId, url, isContract: true }).returning();
  await recordAudit(tx, { actor, action: "job_attachment.create", entityType: "job_attachment", entityId: row.id, before: null, after: row });
  return row;
}

/**
 * An attachment's file, for whoever may see it on the detail: coordinators, admins and the detail's vendor see
 * every attachment; personnel see attachments that are not contracts. Anyone else gets NotFound.
 */
export async function readJobAttachmentFile(actor: Actor, tx: Tx, jobId: string, attachmentId: string): Promise<{ row: FileRow; body: Buffer }> {
  const job = await getJob(actor, tx, jobId);
  const att = job.attachments.find((a) => a.id === attachmentId);
  if (!att?.fileId) throw new NotFoundError("Attachment not found.");
  return readStoredFile(tx, att.fileId);
}
