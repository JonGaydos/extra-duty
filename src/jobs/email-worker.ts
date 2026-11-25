import type { PgBoss } from "pg-boss";
import { runInMode, type DataMode } from "@/db/client";
import { deliverInvoiceBatchEmail } from "@/domain/invoices/batch";
import { deliverInvoiceEmail } from "@/domain/invoices/email";
import { getEmailSender } from "@/lib/email/sender";
import {
  decodeEmailJob,
  EMAIL_QUEUE,
  EMAIL_RETRY,
  INVOICE_BATCH_QUEUE,
  INVOICE_EMAIL_QUEUE,
  type EmailJob,
  type InvoiceBatchJob,
  type InvoiceEmailJob,
} from "./boss";

/** The job fields the handlers read (pg-boss's JobWithMetadata satisfies this). */
export type QueuedJob<T> = { data: T; retryCount: number; retryLimit?: number };

/** A plain email job: a send failure throws, so the queue retries it. */
export async function handleEmailJob(job: QueuedJob<EmailJob>): Promise<void> {
  await getEmailSender().send(decodeEmailJob(job.data));
}

export async function handleInvoiceEmailJob(job: QueuedJob<InvoiceEmailJob>): Promise<void> {
  const limit = job.retryLimit ?? EMAIL_RETRY.retryLimit;
  await deliverInvoiceEmail(job.data.invoiceId, { finalAttempt: job.retryCount >= limit, to: job.data.to, noW9: job.data.noW9, w9ReadBy: job.data.w9ReadBy });
}

export async function handleInvoiceBatchJob(job: QueuedJob<InvoiceBatchJob>): Promise<void> {
  const limit = job.retryLimit ?? EMAIL_RETRY.retryLimit;
  await deliverInvoiceBatchEmail(job.data.batchId, { finalAttempt: job.retryCount >= limit });
}

/** Works `boss`'s email queues; `mode` is the database the boss is bound to, and every job runs in it. */
export async function registerEmailHandlers(boss: PgBoss, mode: DataMode = "live"): Promise<void> {
  await boss.work<EmailJob>(EMAIL_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runInMode(mode, () => handleEmailJob(job));
  });
  await boss.work<InvoiceEmailJob>(INVOICE_EMAIL_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runInMode(mode, () => handleInvoiceEmailJob(job));
  });
  await boss.work<InvoiceBatchJob>(INVOICE_BATCH_QUEUE, { includeMetadata: true }, async (jobs) => {
    for (const job of jobs) await runInMode(mode, () => handleInvoiceBatchJob(job));
  });
}
