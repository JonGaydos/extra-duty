import { sql, type SQL } from "drizzle-orm";
import { PgBoss, type Db as IDatabase } from "pg-boss";
import { currentMode, databaseUrl, type DataMode, type Tx } from "@/db/client";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import type { OutgoingEmail } from "@/lib/email/types";

export const EMAIL_QUEUE = "email.send";
export const INVOICE_EMAIL_QUEUE = "email.invoice";
export const INVOICE_BATCH_QUEUE = "email.invoice_batch";
export const NOTIFY_EMAIL_QUEUE = "notify.email";
export const NOTIFY_PUSH_QUEUE = "notify.push";

/** Six retries after the first attempt; each wait doubles from 30 seconds. */
export const EMAIL_RETRY = { retryLimit: 6, retryDelay: 30, retryBackoff: true } as const;

/** Finished email jobs are deleted after an hour; their payloads can hold one-time links. */
export const EMAIL_QUEUE_OPTIONS = { ...EMAIL_RETRY, deleteAfterSeconds: 3600 } as const;

/** A plain email job. The message is encrypted at rest (it can carry a one-time link). */
export type EmailJob = { enc: string };
/**
 * `to`: a resend to these addresses instead of the first send. `noW9`: leave the W-9 off (an extra address never
 * gets it). `w9ReadBy`: the person the W-9 read is audited as (the coordinator resending).
 */
export type InvoiceEmailJob = { invoiceId: string; to?: string[]; noW9?: true; w9ReadBy?: string };
export type InvoiceBatchJob = { batchId: string };

/**
 * pg-boss for one database. `migrate: false` at runtime: the schema and the queues are installed by the release
 * step (installBoss), so the web and worker database role needs no DDL rights.
 */
function createBoss(connectionString: string, opts: { worker: boolean; schedule?: boolean; migrate?: boolean }): PgBoss {
  const boss = new PgBoss({
    connectionString,
    supervise: opts.worker,
    schedule: opts.schedule ?? opts.worker,
    migrate: opts.migrate ?? false,
    application_name: "extra-duty",
  });
  boss.on("error", (err) => console.error("pg-boss error:", err));
  return boss;
}

/** Every queue the app sends to. The tick queues are added by installBoss. */
export const EMAIL_QUEUES = [EMAIL_QUEUE, INVOICE_EMAIL_QUEUE, INVOICE_BATCH_QUEUE, NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE] as const;

/** Installs (or upgrades) the pg-boss schema and creates or updates `queues`. The release step only. */
export async function installBoss(connectionString: string, tickQueues: readonly string[]): Promise<void> {
  const boss = createBoss(connectionString, { worker: false, schedule: false, migrate: true });
  await boss.start();
  try {
    // Sequential: queue setup in the release step, one queue at a time.
    for (const name of EMAIL_QUEUES) {
      await boss.createQueue(name, { ...EMAIL_QUEUE_OPTIONS });
      // createQueue leaves an existing queue alone; this applies changed options.
      await boss.updateQueue(name, { ...EMAIL_QUEUE_OPTIONS });
    }
    // Sequential: queue setup in the release step, one queue at a time.
    for (const name of tickQueues) await boss.createQueue(name);
  } finally {
    await boss.stop({ graceful: false });
  }
}

const instances: Partial<Record<DataMode, Promise<PgBoss>>> = {};

/**
 * The process-wide pg-boss for `mode`'s database (the current mode by default), started on first use. Only the
 * worker passes `worker: true`, which turns on maintenance and, for live, cron scheduling; the web app starts it
 * as a producer. The first caller decides.
 */
export function getBoss(opts: { worker?: boolean; mode?: DataMode } = {}): Promise<PgBoss> {
  const mode = opts.mode ?? currentMode();
  let instance = instances[mode];
  if (!instance) {
    let url: string;
    try {
      url = databaseUrl(mode);
    } catch (err) {
      return Promise.reject(err);
    }
    const worker = opts.worker ?? false;
    // The live worker alone runs the cron; each tick then runs against both databases (see schedule.ts).
    const boss = createBoss(url, { worker, schedule: worker && mode === "live" });
    instance = boss
      .start()
      .then(() => boss)
      .catch(async (err) => {
        delete instances[mode];
        await boss.stop({ graceful: false }).catch(() => {});
        throw err;
      });
    instances[mode] = instance;
  }
  return instance;
}

export async function stopBoss(): Promise<void> {
  // Sequential: each instance is stopped before the next.
  for (const mode of Object.keys(instances) as DataMode[]) {
    const boss = await instances[mode]!.catch(() => undefined);
    delete instances[mode];
    await boss?.stop({ graceful: true, timeout: 10_000 });
  }
}

/** pg-boss's database adapter over an open Drizzle transaction, so a job commits or rolls back with it. */
export function txDb(tx: Tx): IDatabase {
  return {
    async executeSql(text, values = []) {
      // pg-boss writes $1..$n placeholders; rebuild them as Drizzle params.
      const parts: SQL[] = [];
      text.split(/\$(\d+)/).forEach((chunk, i) => parts.push(i % 2 === 0 ? sql.raw(chunk) : sql`${values[Number(chunk) - 1]}`));
      const res = await tx.execute(sql.join(parts, sql.raw("")));
      return { rows: res.rows };
    },
  };
}

/** The message inside a queued email job. */
export function decodeEmailJob(job: EmailJob): OutgoingEmail {
  return JSON.parse(decryptSecret(job.enc)) as OutgoingEmail;
}

/**
 * Queues a plain email inside the caller's transaction: the job row is written with the same connection,
 * so a rollback leaves nothing to send and a commit makes it visible to the worker. Attachments are not
 * carried in the job (queue an invoice id instead; see queueInvoiceEmail).
 */
export async function queueEmail(tx: Tx, msg: OutgoingEmail): Promise<void> {
  if (msg.attachments?.length) throw new Error("Queued emails cannot carry attachments; queue the record and build them when sending.");
  const boss = await getBoss();
  const { to, replyTo, subject, text, html, auth } = msg;
  // `auth` travels with it: on staging only allowlisted sign-in email may leave.
  const job: EmailJob = { enc: encryptSecret(JSON.stringify({ to, replyTo, subject, text, html, auth })) };
  const id = await boss.send(EMAIL_QUEUE, job, { db: txDb(tx) });
  if (!id) throw new Error("The email could not be queued.");
}

/** Queues an invoice email job (the worker renders the PDF at send time), inside the caller's transaction. */
export async function queueInvoiceJob(tx: Tx, invoiceId: string, opts: Omit<InvoiceEmailJob, "invoiceId"> = {}): Promise<void> {
  const boss = await getBoss();
  const job: InvoiceEmailJob = { invoiceId, ...opts };
  const id = await boss.send(INVOICE_EMAIL_QUEUE, job, { db: txDb(tx) });
  if (!id) throw new Error("The invoice email could not be queued.");
}

/** Queues one vendor batch email job (the worker renders the cover and every PDF at send time), inside the caller's transaction. */
export async function queueInvoiceBatchJob(tx: Tx, batchId: string): Promise<void> {
  const boss = await getBoss();
  const job: InvoiceBatchJob = { batchId };
  const id = await boss.send(INVOICE_BATCH_QUEUE, job, { db: txDb(tx) });
  if (!id) throw new Error("The invoice batch email could not be queued.");
}
