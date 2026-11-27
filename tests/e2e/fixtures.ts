/**
 * Fixtures for the cross-role flow tests in tests/e2e/flows: a test email capture, a seeded agency for each test,
 * real sign-in with emailed two-factor codes, and clock control.
 *
 * Email: the agency's SMTP settings point at a small SMTP server in this process (E2E.smtpPort), so anything the app
 * sends at once (sign-in codes, test emails) lands in `mail`. Queued email (invoices, batches, alerts) is delivered by
 * `clock.deliver()`, which runs the worker's email handlers here, into the same mailbox.
 *
 * Clock: the app server runs on real time, so a test moves time for one detail instead. `clock.advance(jobId, at)`
 * shifts every stored time of that detail back (its sign-ups, watches, offers, invoices, payment issues and ops plans
 * with it) so that the moment `at` of the detail is now. `clock.tick(name, at)` runs a scheduled job at a chosen time,
 * as the worker would.
 *
 * Each test gets its own vendor, people and details (names carry a short tag where they must be unique), so the
 * flows can run again against the same server, as they do in Playwright UI mode.
 */
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { test as base, expect, type Browser, type BrowserContext, type Page, type TestInfo } from "@playwright/test";
import { hashPassword } from "better-auth/crypto";
import { PDFParse } from "pdf-parse";
import { eq, inArray } from "drizzle-orm";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { db as appDb } from "@/db/client";
import { seedApprovedW9 } from "./w9-seed";
import { accounts, jobPositions, jobs, jobTypes, positionTypes, qualifications, ranks, userQualifications, users, vendorLocations, vendors, vendorUsers } from "@/db/schema";
import { updateSettings } from "@/domain/settings/settings";
import type { SettingsPatch } from "@/domain/settings/settings";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";
import { EMAIL_QUEUE, INVOICE_BATCH_QUEUE, INVOICE_EMAIL_QUEUE, NOTIFY_EMAIL_QUEUE, getBoss, stopBoss } from "@/jobs/boss";
import { handleEmailJob, handleInvoiceBatchJob, handleInvoiceEmailJob } from "@/jobs/email-worker";
import { SCHEDULE, runTick } from "@/jobs/schedule";
import { getEmailSender, setEmailSender } from "@/lib/email/sender";
import { notificationEmail } from "@/lib/email/templates/notification";
import { decodeNotifyJob, type NotifyJob } from "@/domain/notifications/notify";
import { E2E } from "./env";
import { signInEmail } from "./session";

// The app code this process runs (ticks, queued email) talks to the e2e database with the e2e server's keys.
process.env.DATABASE_URL = E2E.databaseURL;
process.env.SECRETS_KEY = E2E.appEnv.SECRETS_KEY;
process.env.FILE_MASTER_KEY = E2E.appEnv.FILE_MASTER_KEY;
process.env.BETTER_AUTH_URL = E2E.baseURL;
// The same deployment and storage as the server, so queued email reads its files (an unset APP_ENV is production,
// which requires STORAGE_DRIVER).
process.env.APP_ENV = E2E.appEnv.APP_ENV;
process.env.STORAGE_DRIVER = E2E.appEnv.STORAGE_DRIVER;

export { expect };
export const PHONE = { width: 390, height: 844 };
export const DESKTOP = { width: 1280, height: 900 };
export const TZ = "America/Chicago";
/** Every flow account's password, random for each run. */
export const PASSWORD = randomBytes(18).toString("base64url");

const DAY = 86_400_000;
const QUARTER = 15 * 60_000;

// ---------------------------------------------------------------------------------------------------------------
// Email capture

/** `files` holds the attachments' content for queued mail (SMTP mail lists names only). */
export type Mail = { to: string[]; subject: string; text: string; attachments: string[]; files: Array<{ filename: string; content: Buffer }>; at: number };
export type MailMatch = { to?: string; subject?: string | RegExp; since?: number };

export class Mailbox {
  readonly messages: Mail[] = [];
  /** A point in time: pass it as `since` to look only at mail that arrives later. */
  mark(): number {
    return Date.now();
  }
  find(m: MailMatch = {}): Mail[] {
    return this.messages.filter(
      (x) =>
        (m.since === undefined || x.at >= m.since) &&
        (m.to === undefined || x.to.some((t) => t.toLowerCase() === m.to!.toLowerCase())) &&
        (m.subject === undefined || (typeof m.subject === "string" ? x.subject === m.subject : m.subject.test(x.subject))),
    );
  }
  async waitFor(m: MailMatch, timeout = 15_000): Promise<Mail> {
    let found: Mail | undefined;
    await expect.poll(() => (found = this.find(m).at(-1)) !== undefined, { message: `email ${JSON.stringify({ ...m, subject: String(m.subject) })}`, timeout }).toBe(true);
    return found!;
  }
}

/** Quoted-printable soft breaks and escapes, enough to read a code or a sentence. */
function unQuote(s: string): string {
  return s.replace(/=\r?\n/g, "").replace(/=([0-9A-F]{2})/g, (_, h: string) => String.fromCodePoint(Number.parseInt(h, 16)));
}

function parseRaw(raw: string, rcpt: string[]): Mail {
  const [head] = raw.split(/\r?\n\r?\n/);
  const subject = /^Subject: (.*(?:\r?\n[ \t].*)*)/im.exec(head)?.[1].replace(/\r?\n[ \t]/g, " ") ?? "";
  const attachments = [...new Set([...raw.matchAll(/filename="?([^";\r\n]+)"?/g)].map((x) => x[1]))];
  return { to: rcpt, subject, text: unQuote(raw), attachments, files: [], at: Date.now() };
}

/** Runs every job waiting in one queue, in order; a failed job is failed in the queue and listed in `errors`. */
async function drain(boss: Awaited<ReturnType<typeof getBoss>>, queue: string, handle: (job: never) => Promise<void>, errors: string[]): Promise<void> {
  // Sequential: each batch is fetched after the last is handled, and jobs run in queue order, as the worker runs them.
  for (;;) {
    const batch = await boss.fetch(queue, { batchSize: 100, includeMetadata: true });
    if (!batch.length) return;
    for (const job of batch) {
      try {
        await handle(job as never);
        await boss.complete(queue, job.id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`${queue} job ${job.id}: ${message}`);
        await boss.fail(queue, job.id, { message });
      }
    }
  }
}

/** The SMTP capture is listening, so mail sent to it is kept. */
function assertCapturing(smtp: Server): void {
  if (!smtp.listening) throw new Error("The SMTP capture is not listening.");
}

/** A tiny SMTP server that keeps every message (no TLS, no auth). */
function startSmtp(box: Mailbox, port: number): Promise<Server> {
  const server = createServer((socket) => {
    let buf = "";
    let data: string | null = null;
    let rcpt: string[] = [];
    socket.write("220 flow-capture ESMTP\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (data !== null) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end < 0) return;
          data += buf.slice(0, end);
          buf = buf.slice(end + 5);
          box.messages.push(parseRaw(data.replace(/^\.\./gm, "."), rcpt));
          data = null;
          rcpt = [];
          socket.write("250 OK\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl < 0) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO") socket.write("250-flow-capture\r\n250 8BITMIME\r\n");
        else if (cmd === "RCPT") {
          rcpt.push(/<([^<>]*)>/.exec(line)?.[1] ?? "");
          socket.write("250 OK\r\n");
        } else if (cmd === "DATA") {
          data = "";
          socket.write("354 End with <CR><LF>.<CR><LF>\r\n");
        } else if (cmd === "QUIT") {
          socket.end("221 Bye\r\n");
          return;
        } else socket.write("250 OK\r\n");
      }
    });
    socket.on("error", () => {});
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

// ---------------------------------------------------------------------------------------------------------------
// The seeded agency

export type Person = { id: string; name: string; email: string };

export type Detail = { id: string; number: number; positionId: string; title: string; startAt: Date; endAt: Date };

export type DetailInput = {
  title: string;
  startAt: Date;
  hours?: number;
  count?: number;
  position?: string;
  rateCents?: number;
  /** Defaults to two days ago (open for sign-up). */
  releaseAt?: Date | null;
  opsPlanRequired?: boolean;
  vendorId?: string;
};

/** Agency wall-clock time `days` from today, at hour:minute. */
export function agencyAt(days: number, hour: number, minute = 0): Date {
  const p = agencyDateParts(new Date());
  return agencyInstant(p.year, p.month, p.day + days, hour, minute);
}

/** YYYY-MM-DD in agency time. */
export function agencyDay(d: Date): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
}

let passwordHash: Promise<string> | undefined;

export class Agency {
  readonly vendor: { id: string; name: string; billingEmail: string; location: { id: string; name: string; address: string } };
  constructor(
    readonly tag: string,
    readonly coordinator: Person,
    readonly admin: Person,
    readonly vendorLogin: Person,
    readonly deputy: Person,
    vendor: Agency["vendor"],
  ) {
    this.vendor = vendor;
  }

  static async create(): Promise<Agency> {
    const tag = randomBytes(3).toString("hex").toUpperCase().slice(0, 4);
    const email = (who: string) => `${who}.${tag.toLowerCase()}@flow.test`;
    const billingEmail = `ap.${tag.toLowerCase()}@vendor.example`;
    const [v] = await appDb
      .insert(vendors)
      .values({ name: `Grayton Lake Events ${tag}`, billingEmails: [billingEmail], defaultRateCents: 6500, contactName: "Events office" })
      .returning();
    const address = "174 Lakeview Blvd E, Gulf Haven, FL 32400";
    const [loc] = await appDb.insert(vendorLocations).values({ vendorId: v.id, name: "Lakeside amphitheater", address, lat: 29.3712, lng: -82.2244 }).returning();
    const coordinator = await person({ name: "Robin Castillo", email: email("coordinator"), role: "coordinator" });
    const admin = await person({ name: "Lee Avalos", email: email("admin"), role: "admin" });
    const vendorLogin = await person({ name: "Jamie Ortiz", email: email("vendor"), role: "vendor" });
    await appDb.insert(vendorUsers).values({ userId: vendorLogin.id, vendorId: v.id });
    const deputy = await person({ name: "Drew Fowler", email: email("deputy"), role: "personnel" });
    return new Agency(tag, coordinator, admin, vendorLogin, deputy, { id: v.id, name: v.name, billingEmail, location: { id: loc.id, name: loc.name, address } });
  }

  /** Another deputy (rank Deputy Sheriff unless given), with flags by name; with an approved W-9 unless `w9: false`. */
  async addDeputy(name: string, o: { rank?: string; flags?: string[]; w9?: boolean } = {}): Promise<Person> {
    const p = await person({ name, email: `${name.toLowerCase().replace(/[^a-z]+/g, ".")}.${this.tag.toLowerCase()}@flow.test`, role: "personnel", rank: o.rank, w9: o.w9 });
    if (o.flags?.length) {
      const qs = await appDb.select().from(qualifications).where(inArray(qualifications.name, o.flags));
      for (const q of qs) await appDb.insert(userQualifications).values({ userId: p.id, qualificationId: q.id });
    }
    return p;
  }

  /** A detail written straight to the database, open for sign-up unless `releaseAt` says otherwise. */
  async detail(i: DetailInput): Promise<Detail> {
    const [type] = await appDb.select().from(jobTypes).limit(1);
    const [pos] = await appDb.select().from(positionTypes).where(eq(positionTypes.name, i.position ?? "Deputy Sheriff"));
    const endAt = new Date(i.startAt.getTime() + (i.hours ?? 4) * 3_600_000);
    const [j] = await appDb
      .insert(jobs)
      .values({
        vendorId: i.vendorId ?? this.vendor.id,
        locationId: i.vendorId ? null : this.vendor.location.id,
        typeId: type.id,
        title: i.title,
        startAt: i.startAt,
        endAt,
        rateCents: i.rateCents ?? 6500,
        state: "scheduled",
        releaseAt: i.releaseAt === undefined ? new Date(Date.now() - 2 * DAY) : i.releaseAt,
        opsPlanRequired: i.opsPlanRequired ?? false,
      })
      .returning();
    const [p] = await appDb.insert(jobPositions).values({ jobId: j.id, positionTypeId: pos.id, count: i.count ?? 1 }).returning();
    return { id: j.id, number: j.number, positionId: p.id, title: j.title, startAt: j.startAt, endAt: j.endAt };
  }

  /** Puts a person on a detail as signed up (or a numbered backup), the way sign-up writes it. */
  async signUp(d: Detail, p: Person, backup?: number): Promise<string> {
    const rows = await sql<{ id: string }>(
      `insert into assignments (id, job_id, job_position_id, user_id, status, backup_position, warning_version, warning_accepted_at, planned_start_at, planned_end_at, requested_at)
       values ($1, $2, $3, $4, $5, $6, '1', now(), $7, $8, now() - make_interval(mins => $9)) returning id`,
      [uuidv7(), d.id, d.positionId, p.id, backup ? "backup" : "signed_up", backup ?? null, d.startAt, d.endAt, backup ?? 0],
    );
    return rows[0].id;
  }

  /** Changes agency settings as this agency's admin. */
  async settings(patch: SettingsPatch): Promise<void> {
    await appDb.transaction((tx) => updateSettings({ userId: this.admin.id, role: "admin", rankId: null, vendorId: null }, tx, patch));
  }
}

async function person(p: { name: string; email: string; role: "personnel" | "coordinator" | "admin" | "vendor"; rank?: string; w9?: boolean }): Promise<Person> {
  const rankName = p.role === "personnel" ? (p.rank ?? "Deputy Sheriff") : null;
  const [rank] = rankName ? await appDb.select().from(ranks).where(eq(ranks.name, rankName)) : [];
  const [u] = await appDb
    .insert(users)
    .values({
      name: p.name,
      email: p.email,
      emailVerified: true,
      role: p.role,
      rankId: rank?.id ?? null,
      mailingAddress: p.role === "personnel" ? "PO Box 31, Gulf Haven, FL 32400" : null,
      phone: p.role === "personnel" ? "850-555-0131" : null,
    })
    .returning();
  passwordHash ??= hashPassword(PASSWORD);
  await appDb.insert(accounts).values({ id: uuidv7(), accountId: u.id, providerId: "credential", userId: u.id, password: await passwordHash });
  // Sign-ups need an approved W-9 (owner decision 2026-11-27); a flow that tests the W-9 itself passes w9: false.
  if (p.role !== "vendor" && p.w9 !== false) await seedApprovedW9(appDb, u.id);
  return { id: u.id, name: u.name, email: u.email };
}

// ---------------------------------------------------------------------------------------------------------------
// Database helpers

export async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}
export const one = async <T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T> => (await sql<T>(text, params))[0];

// ---------------------------------------------------------------------------------------------------------------
// Clock control

/** Rows that belong to one detail, by how they reach it. Every timestamptz column on them moves together. */
const LINKED: Array<{ table: string; where: string }> = [
  { table: "jobs", where: "id = $1" },
  { table: "job_positions", where: "job_id = $1" },
  { table: "assignments", where: "job_id = $1" },
  { table: "job_watches", where: "job_id = $1" },
  { table: "job_change_requests", where: "job_id = $1" },
  { table: "spot_offers", where: "job_position_id in (select id from job_positions where job_id = $1)" },
  { table: "invoices", where: "assignment_id in (select id from assignments where job_id = $1)" },
  { table: "invoice_events", where: "invoice_id in (select i.id from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1)" },
  { table: "payment_issues", where: "invoice_id in (select i.id from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1)" },
  {
    table: "payment_issue_notes",
    where: "issue_id in (select p.id from payment_issues p join invoices i on i.id = p.invoice_id join assignments a on a.id = i.assignment_id where a.job_id = $1)",
  },
  { table: "ops_plans", where: "job_id = $1" },
  { table: "ops_plan_versions", where: "ops_plan_id in (select id from ops_plans where job_id = $1)" },
];

/**
 * The worker's alert email handler (src/jobs/notification-worker.ts), restated because that module also loads
 * web-push, which Playwright's module loader cannot import.
 */
async function handleAlertEmail(job: { data: NotifyJob }): Promise<void> {
  const c = decodeNotifyJob(job.data);
  const [u] = await appDb.select({ email: users.email, active: users.active }).from(users).where(eq(users.id, c.userId));
  if (!u?.active || !u.email) return;
  await getEmailSender().send(notificationEmail(u.email, c.title, c.body, `${E2E.baseURL}${c.link}`));
}

export class Clock {
  constructor(private readonly mailbox: Mailbox) {}

  /**
   * Moves one detail through time: afterwards, the moment `at` of the detail (and everything on it) has just passed.
   * The step is whole quarter hours, so times on the quarter hour stay there (`at` lands up to 15 minutes ago).
   */
  async advance(jobId: string, at: Date): Promise<void> {
    const ms = Math.ceil((at.getTime() - Date.now()) / QUARTER) * QUARTER;
    if (ms <= 0) return;
    const client = new Client({ connectionString: E2E.databaseURL });
    await client.connect();
    try {
      const cols = await client.query<{ table_name: string; column_name: string }>(
        "select table_name, column_name from information_schema.columns where table_schema = 'public' and data_type = 'timestamp with time zone' and table_name = any($1)",
        [LINKED.map((l) => l.table)],
      );
      await client.query("begin");
      for (const l of LINKED) {
        const names = cols.rows.filter((c) => c.table_name === l.table).map((c) => c.column_name);
        if (names.length === 0) continue;
        const set = names.map((c) => `"${c}" = "${c}" - make_interval(secs => $2::double precision / 1000)`).join(", ");
        await client.query(`update ${l.table} set ${set} where ${l.where}`, [jobId, ms]);
      }
      await client.query("commit");
    } catch (e) {
      await client.query("rollback").catch(() => {});
      throw e;
    } finally {
      await client.end();
    }
  }

  /** Moves a detail so its release, start or end (plus `minutes`) is now. */
  async advanceTo(jobId: string, moment: "release" | "start" | "end", minutes = 1): Promise<void> {
    const j = await one<{ release_at: Date; start_at: Date; end_at: Date }>("select release_at, start_at, end_at from jobs where id = $1", [jobId]);
    const at = { release: j.release_at, start: j.start_at, end: j.end_at }[moment];
    await this.advance(jobId, new Date(at.getTime() + minutes * 60_000));
  }

  /** Runs one scheduled job (by its name in src/jobs/schedule.ts) as if the worker woke at `at`. */
  async tick(name: string, at: Date = new Date()): Promise<void> {
    const t = SCHEDULE.find((s) => s.name === name);
    if (!t) throw new Error(`No scheduled job ${name}`);
    await runTick(t, at);
  }

  /** Delivers queued email (plain, invoice, batch and alert email) into the mailbox, the way the worker would. Throws if any send failed. */
  async deliver(): Promise<void> {
    setEmailSender({
      // EmailSender.send returns a promise; the capture stores the message at once.
      send: (msg) => {
        const files = (msg.attachments ?? []).map((a) => ({ filename: a.filename, content: a.content }));
        this.mailbox.messages.push({ to: msg.to, subject: msg.subject, text: msg.text, attachments: files.map((f) => f.filename), files, at: Date.now() });
        return Promise.resolve();
      },
    });
    const boss = await getBoss();
    const queues: Array<[string, (job: never) => Promise<void>]> = [
      [EMAIL_QUEUE, handleEmailJob as (job: never) => Promise<void>],
      [INVOICE_EMAIL_QUEUE, handleInvoiceEmailJob as (job: never) => Promise<void>],
      [INVOICE_BATCH_QUEUE, handleInvoiceBatchJob as (job: never) => Promise<void>],
      [NOTIFY_EMAIL_QUEUE, handleAlertEmail as (job: never) => Promise<void>],
    ];
    // A handler that throws fails its job (as the worker would) and fails the test after the rest are delivered, so a
    // check that no email arrived can never pass because sending broke.
    const errors: string[] = [];
    // Sequential: one queue after another, in order, as the worker would.
    for (const [queue, handle] of queues) await drain(boss, queue, handle, errors);
    if (errors.length) throw new Error(`Queued email failed to send:\n${errors.join("\n")}`);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// The test fixtures

type SignInOptions = { viewport?: { width: number; height: number }; colorScheme?: "light" | "dark" };

type Fixtures = {
  agency: Agency;
  clock: Clock;
  mail: Mailbox;
  /** Signs in through the real sign-in page with the emailed code, in a context of its own. */
  signIn: (who: Person, o?: SignInOptions) => Promise<Page>;
  /** A quick sign-in by session cookie, for the parts of a flow that are not about signing in. */
  session: (who: Person, o?: SignInOptions) => Promise<Page>;
};

type WorkerFixtures = { mailbox: Mailbox; smtp: Server };

/** The browsers a test opened for its people. Each one is recorded on its own when the project records video. */
class People {
  private readonly open: Array<{ context: BrowserContext; page: Page; who: Person }> = [];
  constructor(
    private readonly browser: Browser,
    private readonly testInfo: TestInfo,
  ) {}

  async page(who: Person, o: SignInOptions = {}): Promise<Page> {
    const viewport = o.viewport ?? DESKTOP;
    const video = this.testInfo.project.use.video;
    const record = (typeof video === "string" ? video : video?.mode) ?? "off";
    const context = await this.browser.newContext({
      viewport,
      colorScheme: o.colorScheme ?? "light",
      timezoneId: TZ,
      // Contexts a test opens itself are not recorded by the video setting, so these ask for it.
      ...(record !== "off" ? { recordVideo: { dir: this.testInfo.outputPath("videos"), size: viewport } } : {}),
    });
    const page = await context.newPage();
    this.open.push({ context, page, who });
    return page;
  }

  /** Closes every browser (which saves its video) and attaches each video to the test, named for the person. */
  async close(): Promise<void> {
    for (const { context, page, who } of this.open) {
      await context.close();
      const path = await page.video()?.path().catch(() => undefined);
      if (!path) continue;
      // attach copies the file into the test's attachments; the raw recording is not needed twice.
      await this.testInfo.attach(`video, ${who.name}`, { path, contentType: "video/webm" });
      await rm(path, { force: true });
    }
  }
}

export const test = base.extend<Fixtures, WorkerFixtures>({
  mailbox: [
    async ({}, provide) => {
      await provide(new Mailbox());
      await stopBoss();
      await appDb.$client.end().catch(() => {});
    },
    { scope: "worker" },
  ],
  smtp: [
    async ({ mailbox }, provide) => {
      const server = await startSmtp(mailbox, E2E.smtpPort);
      await provide(server);
      await new Promise((r) => server.close(r));
    },
    { scope: "worker" },
  ],
  mail: async ({ mailbox, smtp }, provide) => {
    // Named so Playwright starts the SMTP capture first.
    assertCapturing(smtp);
    await provide(mailbox);
  },
  agency: async ({ smtp }, provide) => {
    // Named so Playwright starts the SMTP capture before mail is pointed at it.
    assertCapturing(smtp);
    const agency = await Agency.create();
    // Mail leaves through the capture; another suite may have pointed it elsewhere.
    await agency.settings({
      email: { provider: "smtp", from: "Signal 90 <no-reply@sheriff.example>", smtp: { host: "127.0.0.1", port: E2E.smtpPort, secure: false, user: "", password: "" } },
      billingReplyToEmail: "billing@sheriff.example",
    });
    await provide(agency);
  },
  clock: async ({ mail }, provide) => {
    await provide(new Clock(mail));
  },
  signIn: async ({ browser, mail }, provide, testInfo) => {
    const people = new People(browser, testInfo);
    await provide(async (who, o) => {
      const page = await people.page(who, o);
      await page.goto("/sign-in");
      await page.getByLabel("Email").fill(who.email);
      await page.getByLabel("Password").fill(PASSWORD);
      const since = mail.mark();
      await page.getByRole("button", { name: "Sign in" }).click();
      await expect(page.getByRole("heading", { name: "Enter your sign-in code" })).toBeVisible();
      const msg = await mail.waitFor({ to: who.email, subject: "Your sign-in code", since });
      const code = /sign-in code is (\d{6})/.exec(msg.text)?.[1];
      expect(code, "a 6-digit code in the email").toBeTruthy();
      await page.getByLabel("Code").fill(code!);
      await page.getByRole("button", { name: "Verify" }).click();
      await page.waitForURL((u) => !/\/(sign-in|two-factor)$/.test(u.pathname) && u.pathname !== "/");
      return page;
    });
    await people.close();
  },
  session: async ({ browser }, provide, testInfo) => {
    const people = new People(browser, testInfo);
    await provide(async (who, o) => {
      const page = await people.page(who, o);
      await signInEmail(page.context(), who.email, who.name);
      return page;
    });
    await people.close();
  },
});

/** "Dec 15, 2026 at 4:00 PM", as the app writes a date and time. */
export function dateTimeText(d: Date): string {
  const date = new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric", year: "numeric" }).format(d);
  const p = agencyDateParts(d);
  return `${date} at ${p.hour % 12 === 0 ? 12 : p.hour % 12}:${String(p.minute).padStart(2, "0")} ${p.hour < 12 ? "AM" : "PM"}`;
}

/** The text of a PDF (an emailed invoice or cover sheet). */
export async function pdfText(content: Buffer): Promise<string> {
  return (await new PDFParse({ data: new Uint8Array(content) }).getText()).text;
}

/** A small valid PDF, for W-9s, ops plans and contracts. */
export function pdf(label: string): { name: string; mimeType: string; buffer: Buffer } {
  const body = `%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Count 0/Kids[]>>endobj\n% ${label}\ntrailer<</Root 1 0 R>>\n%%EOF\n`;
  return { name: `${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}.pdf`, mimeType: "application/pdf", buffer: Buffer.from(body) };
}
