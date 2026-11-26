import { eq, sql } from "drizzle-orm";
import type { PgBoss } from "pg-boss";
import { db, runInMode, type DataMode } from "@/db/client";
import { pushSubscriptions, users } from "@/db/schema";
import { decodeNotifyJob, type NotifyJob } from "@/domain/notifications/notify";
import { encryptSecret } from "@/lib/crypto/secrets";
import { outboxActive } from "@/lib/email/outbox";
import { getEmailSender } from "@/lib/email/sender";
import { notificationEmail } from "@/lib/email/templates/notification";
import { isGone, pushConfigured, sendPush } from "@/lib/push/push";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE } from "./boss";
import type { QueuedJob } from "./email-worker";
import { trimTrailingSlashes } from "@/lib/text";

let warnedNoBase = false;

function appLink(link: string): string | null {
  const base = process.env.APP_URL ?? process.env.BETTER_AUTH_URL;
  if (!base) {
    if (!warnedNoBase) {
      warnedNoBase = true;
      console.warn("Alert emails have no link: set APP_URL or BETTER_AUTH_URL.");
    }
    return null;
  }
  return `${trimTrailingSlashes(base)}${link}`;
}

/** Sends the alert to the address on file at send time. A failure throws, so the queue retries it. */
export async function handleNotificationEmailJob(job: QueuedJob<NotifyJob>): Promise<void> {
  const c = decodeNotifyJob(job.data);
  const [user] = await db.select({ email: users.email, active: users.active }).from(users).where(eq(users.id, c.userId));
  if (!user?.active || !user.email) return;
  await getEmailSender().send(notificationEmail(user.email, c.title, c.body, appLink(c.link)));
}

/**
 * Pushes to every subscription of the user. A 404 or 410 deletes that subscription (a dead endpoint is
 * not a record). Any other failure makes the job throw so the queue retries it; endpoints already sent
 * are saved in the job's data first, so a retry sends only to the ones that failed.
 */
export async function handlePushJob(job: QueuedJob<NotifyJob> & { id?: string }): Promise<void> {
  // Nothing leaves training mode or staging; the in-app inbox still has the alert.
  if (outboxActive() || !pushConfigured()) return;
  const c = decodeNotifyJob(job.data);
  const done = new Set(c.sent ?? []);
  const subs = await db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, c.userId));
  const payload = { title: c.title, body: c.body, url: c.link };
  let failure: unknown;
  // Sequential: one endpoint at a time; the ones sent are recorded so a retry skips them.
  for (const s of subs) {
    if (done.has(s.endpoint)) continue;
    try {
      await sendPush({ endpoint: s.endpoint, keys: s.keys as { p256dh: string; auth: string } }, payload);
      done.add(s.endpoint);
    } catch (err) {
      if (isGone(err)) await db.delete(pushSubscriptions).where(eq(pushSubscriptions.id, s.id));
      else failure = err;
    }
  }
  if (!failure) return;
  if (job.id && done.size > (c.sent?.length ?? 0)) {
    const data: NotifyJob = { enc: encryptSecret(JSON.stringify({ ...c, sent: [...done] })) };
    await db.execute(sql`update pgboss.job set data = ${JSON.stringify(data)}::jsonb where id = ${job.id} and name = ${NOTIFY_PUSH_QUEUE}`);
  }
  throw failure;
}

/** Works `boss`'s alert queues; `mode` is the database the boss is bound to, and every job runs in it. */
export async function registerNotificationHandlers(boss: PgBoss, mode: DataMode = "live"): Promise<void> {
  await boss.work<NotifyJob>(NOTIFY_EMAIL_QUEUE, { includeMetadata: true }, async (jobs) => {
    // Sequential: jobs are handled in queue order.
    for (const job of jobs) await runInMode(mode, () => handleNotificationEmailJob(job));
  });
  await boss.work<NotifyJob>(NOTIFY_PUSH_QUEUE, { includeMetadata: true }, async (jobs) => {
    // Sequential: jobs are handled in queue order.
    for (const job of jobs) await runInMode(mode, () => handlePushJob(job));
  });
}
