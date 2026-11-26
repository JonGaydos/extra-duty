import { beforeAll, describe, expect, test, vi } from "vitest";
import { eq, lte } from "drizzle-orm";
import pg from "pg";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { HOUR, setupFixture } from "../assignments/helpers";
import { assignments, deputyNotes, invoiceEvents, invoices, jobSeries, jobs, opsPlans, paymentIssues, vendorHolds, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { coordinatorTodo, jobAdmin, paymentsBoard, staffInvoice } from "@/domain/coordinator/views";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { realBillingLockReader } from "@/domain/billing/lock";
import { detailsMissingContract } from "@/domain/jobs/contract-status";
import { getJobOpsPlan } from "@/domain/ops-plans/ops-plans";
import { setIssueWaitingOn } from "@/domain/payment-issues/issues";
import { editInvoice } from "@/domain/invoices/review";
import { buildInvoiceMessage } from "@/domain/invoices/email";
import { myInvoices } from "@/domain/personnel/views";
import { createLocalStorage } from "@/lib/storage/local";
import { PDFParse } from "pdf-parse";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateSettings } from "@/domain/settings/settings";

const DAY = 24 * HOUR;
const NOW = new Date("2035-03-10T18:00:00Z");

describe("coordinator views", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let deputy: Actor;

  const invoice = async (o: { status: "pending_review" | "sent"; party: "vendor" | "deputy" | "coordinator"; since: Date; cents: number }) => {
    const { job, positionId } = await f.mkJob();
    const [a] = await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: deputy.userId, status: "billed" }).returning();
    const [inv] = await get()
      .db.insert(invoices)
      .values({ assignmentId: a.id, vendorId: f.vendorId, payeeUserId: deputy.userId, minutes: 360, rateCents: 7000, totalCents: o.cents, status: o.status, sentAt: o.status === "sent" ? o.since : null, responsibleParty: o.party, responsibleSince: o.since })
      .returning();
    return inv;
  };

  beforeAll(async () => {
    f = await setupFixture(get().db, "cv");
    deputy = await f.person();
  });

  test("the payments board groups unpaid invoices by whose turn it is, with days waiting and overdue", async () => {
    const vendorTurn = await invoice({ status: "sent", party: "vendor", since: new Date(NOW.getTime() - 40 * DAY), cents: 42000 });
    const coordTurn = await invoice({ status: "sent", party: "coordinator", since: new Date(NOW.getTime() - 2 * DAY), cents: 30000 });
    await get().db.insert(paymentIssues).values({ invoiceId: coordTurn.id, openedBy: deputy.userId });
    const board = await f.run((tx) => paymentsBoard(f.coord, tx, NOW));
    const v = board.rows.find((r) => r.invoiceId === vendorTurn.id)!;
    const c = board.rows.find((r) => r.invoiceId === coordTurn.id)!;
    expect(v).toMatchObject({ party: "vendor", day: 40, limitDays: 30, overdue: true, issueId: null });
    expect(c).toMatchObject({ party: "coordinator", day: 2, limitDays: 7, overdue: false });
    expect(c.issueId).toBeTruthy();
    expect(board.totals.vendor.cents).toBeGreaterThanOrEqual(42000);
    expect(board.totals.vendor.overdue).toBeGreaterThanOrEqual(1);

    const todo = await f.run((tx) => coordinatorTodo(f.coord, tx, NOW));
    expect(todo.issues.map((i) => i.invoiceId)).toContain(coordTurn.id);
    expect(todo.issues.map((i) => i.invoiceId)).not.toContain(vendorTurn.id);
  });

  test("personnel cannot read the coordinator views", async () => {
    await expect(f.run((tx) => paymentsBoard(deputy, tx, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => coordinatorTodo(deputy, tx, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    const inv = await invoice({ status: "pending_review", party: "coordinator", since: NOW, cents: 1000 });
    await expect(f.run((tx) => staffInvoice(deputy, tx, inv.id, NOW))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the to-do list carries held invoices, pending deputy notes and vendor requests (one row per request)", async () => {
    const held = await invoice({ status: "pending_review", party: "coordinator", since: NOW, cents: 50625 });
    const { job } = await f.mkJob();
    await get().db.insert(deputyNotes).values({ vendorId: f.vendorId, body: "Use the north gate.", submittedBy: deputy.userId, submittedFromJobId: job.id });
    const a = await f.mkJob();
    const b = await f.mkJob();
    const [series] = await get().db.insert(jobSeries).values({ name: "req" }).returning();
    for (const j of [a, b]) await get().db.update(jobs).set({ state: "requested", seriesId: series.id }).where(eq(jobs.id, j.job.id));

    const todo = await f.run((tx) => coordinatorTodo(f.coord, tx, NOW));
    expect(todo.invoices.map((i) => i.id)).toContain(held.id);
    expect(todo.notes.map((n) => n.body)).toContain("Use the north gate.");
    const req = todo.requests.filter((r) => r.jobId === a.job.id || r.jobId === b.job.id);
    expect(req).toHaveLength(1);
    expect(req[0].dates).toBe(2);
  });

  test("a locked detail reports late pay only when the hold came inside the late window", async () => {
    const { job } = await f.mkJob();
    await get().db.update(vendors).set({ paymentHold: true }).where(eq(vendors.id, f.vendorId));
    const [hold] = await get().db.insert(vendorHolds).values({ vendorId: f.vendorId, placedAt: new Date(job.startAt.getTime() - 2 * HOUR) }).returning();
    let admin = await f.run((tx) => jobAdmin(f.coord, tx, job.id));
    expect(admin).toMatchObject({ locked: true, latePay: true });
    await get().db.update(vendorHolds).set({ placedAt: new Date(job.startAt.getTime() - 3 * DAY) }).where(eq(vendorHolds.id, hold.id));
    admin = await f.run((tx) => jobAdmin(f.coord, tx, job.id));
    expect(admin).toMatchObject({ locked: true, latePay: false });
    await get().db.update(vendorHolds).set({ resolvedAt: NOW }).where(eq(vendorHolds.id, hold.id));
    await get().db.update(vendors).set({ paymentHold: false }).where(eq(vendors.id, f.vendorId));
  });

  test("a payment issue waits only on the vendor, the deputy or a coordinator", async () => {
    const inv = await invoice({ status: "sent", party: "coordinator", since: NOW, cents: 1000 });
    const [issue] = await get().db.insert(paymentIssues).values({ invoiceId: inv.id, openedBy: deputy.userId }).returning();
    await expect(f.run((tx) => setIssueWaitingOn(f.coord, tx, issue.id, "nobody" as never))).rejects.toBeInstanceOf(ValidationError);
  });

  test("the staff invoice view names who did each step", async () => {
    const inv = await invoice({ status: "sent", party: "vendor", since: NOW, cents: 42000 });
    await get().db.insert(invoiceEvents).values({ invoiceId: inv.id, actorUserId: f.coord.userId, event: "edited", note: "Fixed the end time", at: NOW });
    const view = await f.run((tx) => staffInvoice(f.coord, tx, inv.id, NOW));
    expect(view.timeline).toEqual([expect.objectContaining({ event: "edited", note: "Fixed the end time", actorName: "cv-coord" })]);
    expect(view.party).toBe("vendor");
  });

  test("no invoice view, email or PDF mentions the agency rate range or an approved exception", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { rateMaxCents: 8000, billingReplyToEmail: "billing@sheriff.test" }));
    await f.run((tx) => updateSettings({ ...f.coord, role: "admin" }, tx, { email: { provider: "smtp", from: "Extra Duty <noreply@sheriff.test>", smtp: { host: "mail.test" } } }));
    await get().db.update(vendors).set({ billingEmails: ["ap@vendor.test"] }).where(eq(vendors.id, f.vendorId));
    try {
      const reason = "Holiday rate agreed with the vendor";
      const inv = await invoice({ status: "pending_review", party: "coordinator", since: NOW, cents: 42000 });
      const [a] = await get().db.select().from(assignments).where(eq(assignments.id, inv.assignmentId));
      await get().db.update(jobs).set({ rateCents: 9000, rateOverrideReason: reason, rateOverrideBy: f.coord.userId, rateOverrideAt: NOW }).where(eq(jobs.id, a.jobId));
      // An out-of-range invoice edit stays allowed: it needs its own reason and is audited.
      await f.run((tx) => editInvoice(f.coord, tx, inv.id, { rateCents: 9500, reason: "Rate per the signed agreement" }));
      const banned = /agency range|outside the|approved outside|Holiday rate agreed/i;

      const staff = await f.run((tx) => staffInvoice(f.coord, tx, inv.id, NOW));
      expect(staff.rateCents).toBe(9500);
      expect(JSON.stringify(staff)).not.toMatch(/agency range|Holiday rate agreed/i);
      const mine = await f.run((tx) => myInvoices(deputy, tx, NOW, inv.id));
      expect(JSON.stringify(mine)).not.toMatch(banned);

      const storage = createLocalStorage(mkdtempSync(join(tmpdir(), "ed-inv-")));
      const msg = await f.run((tx) => buildInvoiceMessage(tx, inv.id, storage));
      expect(`${msg.subject}\n${msg.text}\n${msg.html}`).not.toMatch(banned);
      const pdf = msg.attachments?.find((x) => x.contentType === "application/pdf");
      expect(pdf).toBeTruthy();
      const text = (await new PDFParse({ data: new Uint8Array(pdf!.content as Buffer) }).getText()).text;
      expect(text).toContain("$95");
      expect(text).not.toMatch(banned);
    } finally {
      await f.run((tx) => updateSettings(f.coord, tx, { rateMaxCents: null }));
    }
  });
});

describe("coordinator to-do loading", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  const people: Actor[] = [];

  /** Adds people and future jobs; every fourth job needs an ops plan and every fifth person owes a bill. */
  const grow = async (nPeople: number, nJobs: number) => {
    const { db } = get();
    for (let i = 0; i < nPeople; i++) people.push(await f.person());
    for (let i = 0; i < nJobs; i++) {
      const { job, positionId } = await f.mkJob();
      if (i % 4 === 0) {
        await db.update(jobs).set({ opsPlanRequired: true, opsPlanDueAt: new Date(NOW.getTime() - DAY) }).where(eq(jobs.id, job.id));
        if (i % 8 === 0) await db.insert(opsPlans).values({ jobId: job.id, vendorId: f.vendorId, eventName: job.title, year: 2035 });
      }
      const who = people[i % people.length];
      await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: who.userId, status: "signed_up" });
    }
  };

  /** Statements sent to Postgres while `fn` runs (BEGIN and COMMIT included). */
  const countQueries = async <T>(fn: () => Promise<T>): Promise<{ n: number; result: T }> => {
    const spy = vi.spyOn(pg.Client.prototype, "query");
    try {
      const result = await fn();
      return { n: spy.mock.calls.length, result };
    } finally {
      spy.mockRestore();
    }
  };

  beforeAll(async () => {
    f = await setupFixture(get().db, "load");
    await grow(50, 100);
  }, 120_000);

  test("the query count does not grow with people or jobs", async () => {
    const first = await countQueries(() => f.run((tx) => coordinatorTodo(f.coord, tx, NOW)));
    expect(first.n).toBeLessThanOrEqual(40);
    await grow(50, 100);
    const second = await countQueries(() => f.run((tx) => coordinatorTodo(f.coord, tx, NOW)));
    expect(second.n).toBe(first.n);
    expect(second.result.unfilled.length + second.result.opsOverdue.length).toBeGreaterThan(0);
  }, 180_000);

  test("set-based results match the one-at-a-time services", async () => {
    const todo = await f.run((tx) => coordinatorTodo(f.coord, tx, NOW));
    const expected = [];
    for (const p of [...people, f.coord]) {
      const s = await f.run((tx) => realBillingLockReader(tx, p.userId, NOW));
      if (s.locked) expected.push({ userId: p.userId, unbilled: s.unbilledCount, unacknowledged: s.unacknowledgedCount });
    }
    expect(todo.locks.map(({ userId, unbilled, unacknowledged }) => ({ userId, unbilled, unacknowledged })).sort((a, b) => a.userId.localeCompare(b.userId))).toEqual(
      expected.toSorted((a, b) => a.userId.localeCompare(b.userId)),
    );
    expect(expected.length).toBeGreaterThan(0);

    const old = await f.run((tx) => detailsMissingContract(tx, NOW));
    const ended = new Set((await get().db.select({ id: jobs.id }).from(jobs).where(lte(jobs.endAt, NOW))).map((j) => j.id));
    expect(todo.missingContract.map((m) => m.jobId)).toEqual(old.filter((j) => !ended.has(j.id)).map((j) => j.id));

    const overdue = new Set(todo.opsOverdue.map((o) => o.jobId));
    for (const id of overdue) {
      const plan = await f.run((tx) => getJobOpsPlan(f.coord, tx, id));
      expect(plan.status).not.toBe("agreed");
      expect(plan.dueAt!.getTime()).toBeLessThan(NOW.getTime());
    }
  });
});
