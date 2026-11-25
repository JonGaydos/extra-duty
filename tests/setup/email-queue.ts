import { afterAll, beforeAll } from "vitest";
import { closeDb, db as appDb } from "@/db/client";
import {
  EMAIL_QUEUE,
  INVOICE_BATCH_QUEUE,
  INVOICE_EMAIL_QUEUE,
  NOTIFY_EMAIL_QUEUE,
  NOTIFY_PUSH_QUEUE,
  getBoss,
  stopBoss,
  type EmailJob,
  type InvoiceBatchJob,
  type InvoiceEmailJob,
} from "@/jobs/boss";
import { handleEmailJob, handleInvoiceBatchJob, handleInvoiceEmailJob } from "@/jobs/email-worker";
import { handleNotificationEmailJob, handlePushJob } from "@/jobs/notification-worker";
import type { NotifyJob } from "@/domain/notifications/notify";

/**
 * Call after useTestDb(). Points DATABASE_URL at the test database so queueEmail (pg-boss) and the
 * app's own `db` use it, and stops both before Postgres stops. `drain()` runs the queued email jobs
 * once, in-process, the way the worker would (a throwing job is failed and left for the queue's retry).
 */
export function useEmailQueue(get: () => { url: string }) {
  beforeAll(() => {
    process.env.DATABASE_URL = get().url;
  });
  afterAll(async () => {
    await stopBoss();
    await closeDb(appDb).catch(() => {});
  });

  async function drainQueue<T extends object>(queue: string, handle: (job: { id: string; data: T; retryCount: number; retryLimit: number }) => Promise<void>) {
    const boss = await getBoss();
    for (;;) {
      const jobs = await boss.fetch<T>(queue, { batchSize: 100, includeMetadata: true });
      if (!jobs.length) return;
      for (const job of jobs) {
        try {
          await handle(job);
          await boss.complete(queue, job.id);
        } catch (err) {
          await boss.fail(queue, job.id, { message: err instanceof Error ? err.message : String(err) });
        }
      }
    }
  }

  async function drain(): Promise<void> {
    await drainQueue<EmailJob>(EMAIL_QUEUE, handleEmailJob);
    await drainQueue<InvoiceEmailJob>(INVOICE_EMAIL_QUEUE, handleInvoiceEmailJob);
    await drainQueue<InvoiceBatchJob>(INVOICE_BATCH_QUEUE, handleInvoiceBatchJob);
  }
  /** Runs the queued notification email and push jobs once (kept apart so alerts do not mix into email assertions). */
  async function drainNotifications(): Promise<void> {
    await drainQueue<NotifyJob>(NOTIFY_EMAIL_QUEUE, handleNotificationEmailJob);
    await drainQueue<NotifyJob>(NOTIFY_PUSH_QUEUE, handlePushJob);
  }
  return { drain, drainNotifications };
}
