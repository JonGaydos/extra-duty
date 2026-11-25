import { mkdtemp, readdir } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { and, count, eq, sql } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import { useTestDb } from "../../setup/test-db";
import { closeDb, currentMode, dbFor, liveDb, runInMode, runnerFor, type Db } from "@/db/client";
import { buildDemoData, seedDemo } from "@/db/demo-seed";
import { runMigrations } from "@/db/migrate";
import { seed } from "@/db/seed";
import { assignments, invoices, jobPositions, jobs, jobTypes, positionTypes, ranks, sessions, trainingOutbox, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { signUp } from "@/domain/assignments/signup";
import { billAssignment } from "@/domain/billing/bill";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { queueInvoiceEmail } from "@/domain/invoices/email";
import { buildInvoicePdfData } from "@/domain/invoices/invoices";
import { createJob, type JobInput } from "@/domain/jobs/jobs";
import { updateSettings } from "@/domain/settings/settings";
import { contextForSession, practiceActor, switchMode, type PracticeRole } from "@/domain/training/mode";
import { resetTrainingData } from "@/domain/training/reset";
import { uploadW9 } from "@/domain/w9/w9";
import { INVOICE_EMAIL_QUEUE, getBoss, stopBoss, type InvoiceEmailJob } from "@/jobs/boss";
import { handleInvoiceEmailJob } from "@/jobs/email-worker";
import { runTick, SCHEDULE } from "@/jobs/schedule";
import { getAuth } from "@/lib/auth";
import { encryptSecret } from "@/lib/crypto/secrets";
import { outboxSender } from "@/lib/email/outbox";
import { senderFromSettings } from "@/lib/email/provider";
import { getEmailSender, setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const W9 = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("w9 ".repeat(40))]);

async function fileCount(dir: string): Promise<number> {
  try {
    return (await readdir(dir, { recursive: true, withFileTypes: true })).filter((e) => e.isFile()).length;
  } catch {
    return 0;
  }
}

async function counts(db: Db) {
  const n = async (t: typeof jobs | typeof assignments | typeof invoices) => (await db.select({ n: count() }).from(t))[0].n;
  return { jobs: await n(jobs), assignments: await n(assignments), invoices: await n(invoices) };
}

describe("training mode", () => {
  const get = useTestDb();
  const mail = createMemorySender();
  let smtp: Server;
  let smtpConnections = 0;
  let liveDir: string;
  let trainingDir: string;
  let coordinator: Actor;
  let personnel: Actor;
  let liveFixture: { vendorId: string; typeId: string; positionTypeId: string };
  const today = new Date();

  beforeAll(async () => {
    const { db, url } = get();
    await db.execute(sql`create database training`);
    const trainingUrl = url.replace(/\/test$/, "/training");
    await runMigrations(trainingUrl);
    liveDir = await mkdtemp(join(tmpdir(), "extra-duty-live-"));
    trainingDir = await mkdtemp(join(tmpdir(), "extra-duty-training-"));
    Object.assign(process.env, {
      DATABASE_URL: url,
      TRAINING_DATABASE_URL: trainingUrl,
      STORAGE_DRIVER: "local",
      STORAGE_LOCAL_DIR: liveDir,
      TRAINING_STORAGE_LOCAL_DIR: trainingDir,
    });
    // A mail server that counts connections: nothing in training or on staging may ever open one.
    smtp = createServer((s) => {
      smtpConnections++;
      s.destroy();
    });
    await new Promise<void>((r) => smtp.listen(0, "127.0.0.1", r));
    setEmailSender(mail);

    await seed(db);
    const [ds] = await db.select().from(ranks).where(eq(ranks.name, "Deputy Sheriff"));
    const [c] = await db.insert(users).values({ name: "Live Coord", email: "coord@live.test", role: "coordinator" }).returning();
    const [p] = await db.insert(users).values({ name: "Live Deputy", email: "deputy@live.test", role: "personnel", rankId: ds.id, mailingAddress: "1 Main St, Town, FL 32400" }).returning();
    coordinator = { userId: c.id, role: "coordinator", rankId: null, vendorId: null };
    personnel = { userId: p.id, role: "personnel", rankId: ds.id, vendorId: null };
    const [v] = await db.insert(vendors).values({ name: "Live Vendor", defaultRateCents: 6000, billingEmails: ["ap@live-vendor.test"] }).returning();
    const [t] = await db.select().from(jobTypes).limit(1);
    const [pt] = await db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
    liveFixture = { vendorId: v.id, typeId: t.id, positionTypeId: pt.id };
    const smtpSettings = { email: { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.test>", smtp: { host: "127.0.0.1", port: (smtp.address() as { port: number }).port, secure: false } }, billingReplyToEmail: "billing@sheriff.test" };
    await db.transaction((tx) => updateSettings({ ...coordinator, role: "admin" }, tx, smtpSettings));

    await runInMode("training", () => seedDemo(dbFor("training"), today));
    await runnerFor("training")(async (tx) => {
      const admin = (await practiceActor(tx, "admin"))!;
      await updateSettings(admin, tx, smtpSettings);
    });
  });

  afterAll(async () => {
    await stopBoss();
    await closeDb(dbFor("training"));
    await closeDb(liveDb);
    await new Promise<void>((r) => smtp.close(() => r()));
    delete process.env.TRAINING_DATABASE_URL;
  });

  async function newSession(userId: string): Promise<{ id: string; userId: string }> {
    const [s] = await liveDb
      .insert(sessions)
      .values({ token: `t-${Math.random()}`, userId, expiresAt: new Date(Date.now() + DAY) })
      .returning({ id: sessions.id, userId: sessions.userId });
    return s;
  }

  async function practice(role: PracticeRole) {
    const s = await newSession(coordinator.userId);
    await liveDb.transaction((tx) => switchMode(coordinator, tx, s.id, "training", role));
    return (await contextForSession(s))!;
  }

  const liveJob = (start: Date): JobInput => ({
    vendorId: liveFixture.vendorId,
    locationId: null,
    typeId: liveFixture.typeId,
    title: "Isolation check",
    description: null,
    notes: null,
    startAt: start,
    endAt: new Date(start.getTime() + 2 * HOUR),
    rateCents: 6000,
    positions: [{ positionTypeId: liveFixture.positionTypeId, count: 2 }],
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: null,
    contactPhone: null,
    held: false,
  });

  /** A 2 AM start three days out: released, and clear of every demo detail (none starts before 8 AM). */
  const nightStart = () => {
    const d = new Date(Date.now() + 3 * DAY);
    d.setUTCHours(8, 0, 0, 0); // 2 or 3 AM in Chicago
    return d;
  };

  test("a new sign-in is always live, even while another session of the same person is in training", async () => {
    const auth = await getAuth();
    const ctx = await auth.$context;
    const first = await ctx.internalAdapter.createSession(coordinator.userId);
    await liveDb.transaction((tx) => switchMode(coordinator, tx, first.id, "training", "deputy"));
    const second = await ctx.internalAdapter.createSession(coordinator.userId);
    const [row] = await liveDb.select({ mode: sessions.mode, practiceRole: sessions.practiceRole }).from(sessions).where(eq(sessions.id, second.id));
    expect(row).toEqual({ mode: "live", practiceRole: null });
    expect((await contextForSession({ id: second.id, userId: coordinator.userId }))!.mode).toBe("live");
    expect((await contextForSession({ id: first.id, userId: coordinator.userId }))!.mode).toBe("training");
  });

  test("personnel calling switchMode get ForbiddenError", async () => {
    const s = await newSession(personnel.userId);
    await expect(liveDb.transaction((tx) => switchMode(personnel, tx, s.id, "training", "deputy"))).rejects.toBeInstanceOf(ForbiddenError);
    const [row] = await liveDb.select({ mode: sessions.mode }).from(sessions).where(eq(sessions.id, s.id));
    expect(row.mode).toBe("live");
  });

  test("in training, creating a job, signing up and billing write only to the training database and storage; back in live, only to live", async () => {
    const training = dbFor("training");
    const liveBefore = await counts(liveDb);
    const trainingBefore = await counts(training);
    const liveFiles = await fileCount(liveDir);
    const trainingFiles = await fileCount(trainingDir);

    // As the practice coordinator: create a detail. As the practice deputy: bill the unbilled detail, sign up, upload a W-9.
    const asCoord = await practice("coordinator");
    expect(asCoord.mode).toBe("training");
    const job = await asCoord.run(async (tx) => {
      const [v] = await tx.select().from(vendors).where(eq(vendors.paymentHold, false)).limit(1);
      const [t] = await tx.select().from(jobTypes).limit(1);
      const [pt] = await tx.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
      return createJob(asCoord.actor, tx, { ...liveJob(nightStart()), vendorId: v.id, typeId: t.id, positions: [{ positionTypeId: pt.id, count: 2 }] });
    });
    const asDeputy = await practice("deputy");
    await asDeputy.run(async (tx) => {
      const unbilled = await tx
        .select({ a: assignments, job: jobs })
        .from(assignments)
        .innerJoin(jobs, eq(jobs.id, assignments.jobId))
        .where(and(eq(assignments.userId, asDeputy.actor.userId), eq(assignments.status, "signed_up"), sql`${jobs.endAt} < now()`));
      expect(unbilled.length).toBeGreaterThan(0);
      for (const u of unbilled) await billAssignment(asDeputy.actor, tx, u.a.id, { startAt: u.job.startAt, endAt: u.job.endAt, attachW9: false });
      const [pos] = await tx.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
      await signUp(asDeputy.actor, tx, pos.id, { warningVersion: 1, jobId: job.id });
      await uploadW9(asDeputy.actor, tx, W9, "w9.pdf");
    });

    expect(await counts(liveDb)).toEqual(liveBefore);
    expect(await fileCount(liveDir)).toBe(liveFiles);
    const trainingAfter = await counts(training);
    expect(trainingAfter.jobs).toBe(trainingBefore.jobs + 1);
    expect(trainingAfter.assignments).toBe(trainingBefore.assignments + 1);
    expect(trainingAfter.invoices).toBeGreaterThan(trainingBefore.invoices);
    expect(await fileCount(trainingDir)).toBe(trainingFiles + 1);

    // Back to live: the same actions reach only live.
    await liveDb.transaction((tx) => switchMode(coordinator, tx, asCoord.sessionId, "live"));
    const live = (await contextForSession({ id: asCoord.sessionId, userId: coordinator.userId }))!;
    expect(live.mode).toBe("live");
    expect(live.actor.userId).toBe(coordinator.userId);
    const liveJobRow = await live.run((tx) => createJob(live.actor, tx, liveJob(nightStart())));
    const deputySession = await newSession(personnel.userId);
    const asLiveDeputy = (await contextForSession(deputySession))!;
    await asLiveDeputy.run(async (tx) => {
      const [pos] = await tx.select().from(jobPositions).where(eq(jobPositions.jobId, liveJobRow.id));
      await signUp(asLiveDeputy.actor, tx, pos.id, { warningVersion: 1, jobId: liveJobRow.id });
      // A detail this deputy worked last week, billed now.
      const start = new Date(Date.now() - 7 * DAY);
      const [past] = await tx
        .insert(jobs)
        .values({ vendorId: liveFixture.vendorId, typeId: liveFixture.typeId, title: "Worked last week", startAt: start, endAt: new Date(start.getTime() + 2 * HOUR), rateCents: 6000 })
        .returning();
      await tx.insert(jobPositions).values({ jobId: past.id, positionTypeId: liveFixture.positionTypeId, count: 1 });
      const [ppos] = await tx.select().from(jobPositions).where(eq(jobPositions.jobId, past.id));
      const [a] = await tx.insert(assignments).values({ jobId: past.id, jobPositionId: ppos.id, userId: personnel.userId, status: "signed_up" }).returning();
      await billAssignment(asLiveDeputy.actor, tx, a.id, { startAt: past.startAt, endAt: past.endAt, attachW9: false });
      await uploadW9(asLiveDeputy.actor, tx, W9, "w9.pdf");
    });
    expect(await counts(training)).toEqual(trainingAfter);
    expect(await fileCount(trainingDir)).toBe(trainingFiles + 1);
    expect(await fileCount(liveDir)).toBe(liveFiles + 1);
    expect((await counts(liveDb)).jobs).toBe(liveBefore.jobs + 2);
  });

  test("a request whose session mode changes mid-request keeps the mode it started with", async () => {
    const ctx = await practice("coordinator");
    // Another tab switches the same session back to live while this request runs.
    await liveDb.transaction((tx) => switchMode(coordinator, tx, ctx.sessionId, "live"));
    const where = await ctx.run(async (tx) => ({ mode: currentMode(), db: (await tx.execute<{ db: string }>(sql`select current_database() as db`)).rows[0].db }));
    expect(where).toEqual({ mode: "training", db: "training" });
    expect((await contextForSession({ id: ctx.sessionId, userId: coordinator.userId }))!.mode).toBe("live");
  });

  test("resetTrainingData is refused on the live database and by personnel", async () => {
    await expect(liveDb.transaction((tx) => resetTrainingData(coordinator, tx))).rejects.toBeInstanceOf(ValidationError);
    // Training mode but a live connection: still refused.
    await expect(runInMode("training", () => liveDb.transaction((tx) => resetTrainingData(coordinator, tx)))).rejects.toBeInstanceOf(ValidationError);
    const asDeputy = await practice("deputy");
    await expect(asDeputy.run((tx) => resetTrainingData(asDeputy.actor, tx))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await counts(liveDb)).jobs).toBeGreaterThan(0);
  });

  test("after a reset the training counts match the demo seed, and live is untouched", async () => {
    const liveBefore = await counts(liveDb);
    const asCoord = await practice("coordinator");
    const now = new Date();
    await asCoord.run((tx) => resetTrainingData(asCoord.actor, tx, now));
    const data = buildDemoData(now);
    expect(await counts(dbFor("training"))).toEqual({ jobs: data.jobs.length, assignments: data.assignments.length, invoices: data.invoices.length });
    expect((await dbFor("training").select({ n: count() }).from(users))[0].n).toBe(data.users.length);
    expect(await counts(liveDb)).toEqual(liveBefore);
    // The practice session still works after the reset (the demo user is found again by email).
    expect((await contextForSession({ id: asCoord.sessionId, userId: coordinator.userId }))!.mode).toBe("training");
  });

  test("in training no mail server is contacted and an invoice email lands in the Outbox with its recipients and attachments", async () => {
    mail.clear();
    smtpConnections = 0;
    const asCoord = await practice("coordinator");
    const inv = await asCoord.run(async (tx) => {
      const [row] = await tx
        .select({ id: invoices.id, billingEmails: vendors.billingEmails })
        .from(invoices)
        .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
        .where(eq(invoices.status, "approved_unsent"))
        .limit(1);
      await queueInvoiceEmail(tx, row.id);
      return row;
    });
    // The training worker: its own queue in the training database, every job run in training mode.
    const boss = await getBoss({ mode: "training" });
    const jobsQueued = await boss.fetch<InvoiceEmailJob>(INVOICE_EMAIL_QUEUE, { batchSize: 10, includeMetadata: true });
    // Billing in an earlier test queued one too; every one of them is handled here.
    expect(jobsQueued.map((j) => j.data.invoiceId)).toContain(inv.id);
    for (const j of jobsQueued) await runInMode("training", () => handleInvoiceEmailJob(j));
    // Nothing reached the live queue.
    const liveQueued = await (await getBoss({ mode: "live" })).fetch<InvoiceEmailJob>(INVOICE_EMAIL_QUEUE, { batchSize: 50 });
    expect(liveQueued.map((j) => j.data.invoiceId)).not.toContain(inv.id);

    const [number] = await dbFor("training").select({ n: invoices.number }).from(invoices).where(eq(invoices.id, inv.id));
    const outbox = await dbFor("training").select().from(trainingOutbox);
    const out = outbox.find((m) => m.attachments.some((a) => a.filename.includes(String(number.n).padStart(6, "0"))))!;
    expect(out).toBeTruthy();
    expect(out.to).toEqual(inv.billingEmails);
    expect(out.attachments).toEqual([expect.objectContaining({ contentType: "application/pdf", filename: expect.stringMatching(/\.pdf$/) })]);
    expect(out.attachments[0].size).toBeGreaterThan(0);
    expect(mail.sent).toHaveLength(0);
    expect(smtpConnections).toBe(0);
    expect((await liveDb.select({ n: count() }).from(trainingOutbox))[0].n).toBe(0);
  });

  test("on staging nothing is sent either: every message goes to the outbox", async () => {
    smtpConnections = 0;
    mail.clear();
    process.env.APP_ENV = "staging";
    try {
      // Training stays outbox-only for everything, sign-in email to allowlisted addresses included.
      process.env.STAGING_EMAIL_ALLOWLIST = "ap@live-vendor.test";
      expect(runInMode("training", () => getEmailSender())).toBe(outboxSender);
      delete process.env.STAGING_EMAIL_ALLOWLIST;
      const smtpSender = senderFromSettings({ provider: "smtp", from: "x@sheriff.test", smtp: { host: "127.0.0.1", port: (smtp.address() as { port: number }).port, secure: false, user: "", passwordEnc: encryptSecret("") }, apiKeyEnc: "", region: "" });
      await smtpSender.send({ to: ["ap@live-vendor.test"], subject: "Invoice", text: "t", html: "<p>t</p>", attachments: [{ filename: "ED-000001.pdf", content: Buffer.from("%PDF"), contentType: "application/pdf" }] });
      const [out] = await liveDb.select().from(trainingOutbox);
      expect(out).toMatchObject({ to: ["ap@live-vendor.test"], subject: "Invoice", attachments: [{ filename: "ED-000001.pdf", contentType: "application/pdf", size: 4 }] });
      expect(smtpConnections).toBe(0);
      expect(mail.sent).toHaveLength(0);
    } finally {
      process.env.APP_ENV = "production";
    }
    expect(getEmailSender()).toBe(mail);
  });

  test("invoice PDFs made in training carry TRAINING; live ones do not", async () => {
    const text = async (mode: "live" | "training", id: string) =>
      runInMode(mode, async () => {
        const pdf = await renderInvoicePdf(await runnerFor(mode)((tx) => buildInvoicePdfData(tx, id)));
        return (await new PDFParse({ data: pdf }).getText()).text;
      });
    const [t] = await dbFor("training").select({ id: invoices.id }).from(invoices).limit(1);
    const [l] = await liveDb.select({ id: invoices.id }).from(invoices).limit(1);
    expect(await text("training", t.id)).toContain("TRAINING");
    expect(await text("live", l.id)).not.toContain("TRAINING");
  });

  test("the worker runs each tick against both databases, and the nightly reset against training only", async () => {
    const seen: string[] = [];
    await runTick({ name: "probe", cron: "* * * * *", tz: "America/Chicago", run: async () => void seen.push(currentMode()) });
    expect(seen).toEqual(["live", "training"]);
    const reset = SCHEDULE.find((t) => t.name === "training-reset")!;
    expect(reset).toMatchObject({ cron: "0 2 * * *", tz: "America/Chicago", modes: ["training"] });
  });
});
