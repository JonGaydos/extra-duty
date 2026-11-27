import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, desc, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture, HOUR } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, billingLockOverrides, invoices, jobs, notifications, paymentIssues, paymentMethods, users, vendorHolds, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { eligibilityFor } from "@/domain/assignments/signup";
import { billAssignment } from "@/domain/billing/bill";
import { loadUnbilled, lockedPeople, overrideBillingLock, realBillingLockReader } from "@/domain/billing/lock";
import { applyResponsibility, markPaid } from "@/domain/billing/payments";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { createInvoice } from "@/domain/invoices/invoices";
import { sendBackInvoice } from "@/domain/invoices/review";
import { cancelJob } from "@/domain/jobs/jobs";
import { updateSettings } from "@/domain/settings/settings";
import { billingReadyTick, unbilledRemindersTick } from "@/jobs/unbilled-reminders";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

const DAY = 24 * HOUR;
const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
// Fixture jobs run in 2035; this is well after all of them.
const AFTER = new Date("2036-01-01T15:00:00Z");

describe("billing lock, overrides and reminders", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let method: string;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-lock-"));
    setEmailSender(createMemorySender());
    fx = await setupFixture(db, "lock");
    admin = (await makeUser(db, "admin", "lock-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(eq(vendors.id, fx.vendorId));
    [{ id: method }] = await db.select({ id: paymentMethods.id }).from(paymentMethods).limit(1);
  });

  const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);

  beforeEach(async () => {
    await tx((t) =>
      updateSettings(admin, t, {
        email: GOOD_EMAIL,
        billingReplyToEmail: "billing@sheriff.example",
        invoiceReviewMode: "immediate",
        unbilledGraceHours: 24,
        billingLockEnabled: true,
        paymentAckLockMode: "vendor_reported",
        unbilledReminderFrequency: "daily",
      }),
    );
  });

  async function person() {
    const p = await fx.person();
    await get().db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    return p;
  }
  async function put(userId: string, status: "signed_up" | "late_canceled" | "billed" = "signed_up", o: { vendor?: string } = {}) {
    const { job, positionId } = await fx.mkJob({ vendor: o.vendor });
    const [a] = await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId, status }).returning();
    return { a, job };
  }
  const lock = (userId: string, now = AFTER) => tx((t) => realBillingLockReader(t, userId, now));
  const bill = (p: Actor, a: { id: string }, job: { startAt: Date; endAt: Date }) =>
    tx((t) => billAssignment(p, t, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, AFTER));
  const inbox = (userId: string, type: string) =>
    get().db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type))).orderBy(desc(notifications.createdAt));

  test("a finished detail past grace locks; billing the last one unlocks through eligibilityFor", async () => {
    const p = await person();
    const { a, job } = await put(p.userId);
    expect(await lock(p.userId)).toEqual({ locked: true, unbilledCount: 1, unacknowledgedCount: 0 });
    // inside the grace window it does not count
    expect((await lock(p.userId, new Date(job.endAt.getTime() + 23 * HOUR))).locked).toBe(false);
    expect((await lock(p.userId, new Date(job.endAt.getTime() + 25 * HOUR))).locked).toBe(true);

    const target = await fx.mkJob();
    const check = async () => (await tx((t) => eligibilityFor(p, t, target.job.id, AFTER))).checks.find((c) => c.check === "billing_lock")!;
    expect(await check()).toMatchObject({ ok: false, message: "Bill 1 past detail to sign up again" });
    await bill(p, a, job);
    expect(await check()).toMatchObject({ ok: true });
  });

  test("canceled and payment-locked jobs are not unbilled; a late cancellation counts only after the detail's end plus grace", async () => {
    const p = await person();
    const { db } = get();
    const canceled = await put(p.userId);
    await db.update(jobs).set({ state: "canceled", canceledAt: new Date("2035-01-01") }).where(eq(jobs.id, canceled.job.id));
    await db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, canceled.a.id));
    expect((await lock(p.userId)).unbilledCount).toBe(0);

    const [other] = await db.insert(vendors).values({ name: "Held Vendor", defaultRateCents: 7000 }).returning();
    const held = await put(p.userId, "signed_up", { vendor: other.id });
    await db.insert(vendorHolds).values({ vendorId: other.id, placedAt: new Date("2000-01-01") });
    expect((await lock(p.userId)).unbilledCount).toBe(0);
    await db.update(vendorHolds).set({ resolvedAt: new Date("2000-01-02") }).where(eq(vendorHolds.vendorId, other.id));
    expect((await lock(p.userId)).unbilledCount).toBe(1);
    await db.update(assignments).set({ status: "billed" }).where(eq(assignments.id, held.a.id));

    const late = await put(p.userId);
    await tx((t) => cancelJob(fx.coord, t, late.job.id, "Vendor canceled", { cause: "vendor", now: new Date(late.job.startAt.getTime() - 2 * HOUR) }));
    const cancelAt = new Date(late.job.startAt.getTime() - 2 * HOUR);
    // Counted from the scheduled end, not the cancel: before the end it is not unbilled, and the grace runs from the end.
    const end = late.job.endAt.getTime();
    for (const at of [cancelAt.getTime() + HOUR, end - 60_000]) expect(await tx((t) => loadUnbilled(t, p.userId, new Date(at)))).toEqual([]);
    for (const at of [cancelAt.getTime() + 25 * HOUR, end - 60_000, end + 23 * HOUR]) expect((await lock(p.userId, new Date(at))).unbilledCount).toBe(0);
    // Before the end it is not unbilled at all; after it, it is, and it locks once the grace passes.
    expect((await tx((t) => loadUnbilled(t, p.userId, new Date(end)))).map((u) => u.jobId)).toEqual([late.job.id]);
    expect((await lock(p.userId, new Date(end + 25 * HOUR))).unbilledCount).toBe(1);
    // The coordinators' to-do list (every locked person at once) follows the same rule.
    const lockedAt = async (at: number) => (await tx((t) => lockedPeople(t, new Date(at)))).some((r) => r.userId === p.userId);
    expect(await lockedAt(cancelAt.getTime() + 25 * HOUR)).toBe(false);
    expect(await lockedAt(end + 25 * HOUR)).toBe(true);
  });

  test("the coordinators' locked list gives each person the same answer as their own lock", async () => {
    const { db } = get();
    const unbilled = await person();
    await put(unbilled.userId);
    const canceled = await person();
    const c = await put(canceled.userId);
    await db.update(jobs).set({ state: "canceled", canceledAt: new Date("2035-01-01") }).where(eq(jobs.id, c.job.id));
    const held = await person();
    const [heldVendor] = await db.insert(vendors).values({ name: "Locked List Vendor", defaultRateCents: 7000 }).returning();
    await put(held.userId, "signed_up", { vendor: heldVendor.id });
    await db.insert(vendorHolds).values({ vendorId: heldVendor.id, placedAt: new Date("2000-01-01") });
    const owed = await person();
    const { a: owedA } = await put(owed.userId, "billed");
    const inv = await tx((t) => createInvoice(t, { assignmentId: owedA.id, minutes: 360, rateCents: 7000, status: "sent" }));
    const since = new Date(AFTER.getTime() - 31 * DAY);
    await db.update(invoices).set({ sentAt: since, vendorPaidAt: since }).where(eq(invoices.id, inv.id));
    await tx((t) => applyResponsibility(t, inv.id, since));
    const both = await person();
    await put(both.userId);
    await put(both.userId, "late_canceled");
    const lifted = await person();
    await put(lifted.userId);
    await db.insert(billingLockOverrides).values({ userId: lifted.userId, until: new Date(AFTER.getTime() + DAY), reason: "Paper invoice", createdBy: fx.coord.userId });

    const ids = [unbilled, canceled, held, owed, both, lifted].map((p) => p.userId);
    const compare = async () => {
      const listed = new Map((await tx((t) => lockedPeople(t, AFTER))).map((r) => [r.userId, r]));
      for (const id of ids) {
        const own = await lock(id);
        const row = listed.get(id);
        if (own.locked) expect(row && { locked: row.locked, unbilledCount: row.unbilledCount, unacknowledgedCount: row.unacknowledgedCount }).toEqual(own);
        else expect(row).toBeUndefined();
      }
      return ids.filter((id) => listed.has(id));
    };
    expect(await compare()).toEqual([unbilled.userId, owed.userId, both.userId]);
    await tx((t) => updateSettings(admin, t, { billingLockEnabled: false }));
    expect(await compare()).toEqual([owed.userId]);
    await tx((t) => updateSettings(admin, t, { billingLockEnabled: true, paymentAckLockMode: "off" }));
    expect(await compare()).toEqual([unbilled.userId, both.userId]);
    await tx((t) => updateSettings(admin, t, { billingLockEnabled: false }));
    expect(await tx((t) => lockedPeople(t, AFTER))).toEqual([]);
  });

  test("a returned invoice counts as unbilled again", async () => {
    const p = await person();
    const { a, job } = await put(p.userId);
    await bill(p, a, job);
    expect((await lock(p.userId)).unbilledCount).toBe(0);
    const [inv] = await get().db.select().from(invoices).where(eq(invoices.assignmentId, a.id));
    await tx((t) => sendBackInvoice(fx.coord, t, inv.id, "Check the hours", AFTER));
    expect((await lock(p.userId)).unbilledCount).toBe(1);
  });

  describe("payment acknowledgment", () => {
    async function sent(userId: string, since: Date) {
      const { a } = await put(userId, "billed");
      const created = await tx((t) => createInvoice(t, { assignmentId: a.id, minutes: 360, rateCents: 7000, status: "sent" }));
      await get().db.update(invoices).set({ sentAt: since, vendorPaidAt: since }).where(eq(invoices.id, created.id));
      await tx((t) => applyResponsibility(t, created.id, since));
      return created.id;
    }

    test("a vendor-reported invoice locks after the response days; marking it paid unlocks", async () => {
      const p = await person();
      const id = await sent(p.userId, new Date(AFTER.getTime() - 31 * DAY));
      expect(await lock(p.userId)).toEqual({ locked: true, unbilledCount: 0, unacknowledgedCount: 1 });
      const t = await fx.mkJob();
      const msg = (await tx((x) => eligibilityFor(p, x, t.job.id, AFTER))).checks.find((c) => c.check === "billing_lock")!.message;
      expect(msg).toBe("Confirm payment on 1 invoice to sign up again");
      await tx((x) => markPaid(p, x, id, { paymentMethodId: method, reference: "9", paidAt: new Date(AFTER.getTime() - DAY) }, AFTER));
      expect((await lock(p.userId)).locked).toBe(false);
      // The deputy's confirmation closed it as paid, so it can never lock again.
      expect((await get().db.select().from(invoices).where(eq(invoices.id, id)))[0]).toMatchObject({ status: "paid", responsibleParty: null });
    });

    test("an open payment issue clears it", async () => {
      const p = await person();
      const id = await sent(p.userId, new Date(AFTER.getTime() - 31 * DAY));
      await get().db.insert(paymentIssues).values({ invoiceId: id, openedBy: p.userId, status: "open", waitingOn: "vendor" });
      expect((await lock(p.userId)).locked).toBe(false);
    });

    test("recent vendor mark does not lock", async () => {
      const p = await person();
      await sent(p.userId, new Date(AFTER.getTime() - 5 * DAY));
      expect((await lock(p.userId)).locked).toBe(false);
    });
  });

  describe("override", () => {
    test("a coordinator override unlocks, is audited and notifies; personnel cannot", async () => {
      const p = await person();
      await put(p.userId);
      const until = new Date(AFTER.getTime() + DAY);
      await expect(tx((t) => overrideBillingLock(p, t, p.userId, { reason: "mine", until }, AFTER))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(tx((t) => overrideBillingLock(fx.coord, t, p.userId, { reason: " ", until }, AFTER))).rejects.toBeInstanceOf(ValidationError);
      await expect(tx((t) => overrideBillingLock(fx.coord, t, p.userId, { reason: "x", until: new Date(AFTER.getTime() - 1) }, AFTER))).rejects.toBeInstanceOf(ValidationError);
      expect((await lock(p.userId)).locked).toBe(true);

      await tx((t) => overrideBillingLock(fx.coord, t, p.userId, { reason: "Waiting on vendor paperwork", until }, AFTER));
      expect((await lock(p.userId)).locked).toBe(false);
      expect((await lock(p.userId, new Date(until.getTime() + 1))).locked).toBe(true);
      const [row] = await get().db.select().from(billingLockOverrides).where(eq(billingLockOverrides.userId, p.userId));
      expect(row).toMatchObject({ reason: "Waiting on vendor paperwork", createdBy: fx.coord.userId });
      const audits = await get().db.select().from(auditLog).where(and(eq(auditLog.entityType, "billing_lock_override"), eq(auditLog.entityId, row.id)));
      expect(audits.map((x) => x.action)).toEqual(["billing.lock_override"]);
      expect(await inbox(p.userId, "billing.lock_overridden")).toHaveLength(1);
    });

    test("the newest unexpired override applies", async () => {
      const p = await person();
      await put(p.userId);
      await tx((t) => overrideBillingLock(fx.coord, t, p.userId, { reason: "long", until: new Date(AFTER.getTime() + 10 * DAY) }, new Date(AFTER.getTime() - 2 * HOUR)));
      await tx((t) => overrideBillingLock(fx.coord, t, p.userId, { reason: "short", until: new Date(AFTER.getTime() + HOUR) }, new Date(AFTER.getTime() - HOUR)));
      expect((await lock(p.userId)).locked).toBe(false);
      // the short one has expired but the long one is still the newest unexpired
      expect((await lock(p.userId, new Date(AFTER.getTime() + 2 * HOUR))).locked).toBe(false);
      expect((await lock(p.userId, new Date(AFTER.getTime() + 11 * DAY))).locked).toBe(true);
    });
  });

  describe("billing.ready", () => {
    test("alerts a signed_up assignment once after the job ends, never canceled or locked jobs", async () => {
      const p = await person();
      const { db } = get();
      const ended = await put(p.userId);
      const future = await put(p.userId);
      await db.update(jobs).set({ endAt: new Date(AFTER.getTime() + DAY), startAt: new Date(AFTER.getTime() + HOUR) }).where(eq(jobs.id, future.job.id));
      const canceled = await put(p.userId);
      await db.update(jobs).set({ state: "canceled" }).where(eq(jobs.id, canceled.job.id));
      const [other] = await db.insert(vendors).values({ name: "Held Vendor 2", defaultRateCents: 7000 }).returning();
      const locked = await put(p.userId, "signed_up", { vendor: other.id });
      await db.insert(vendorHolds).values({ vendorId: other.id, placedAt: new Date("2000-01-01") });

      const old = await put(p.userId);
      await db.update(jobs).set({ startAt: new Date(AFTER.getTime() - 8 * DAY - 6 * HOUR), endAt: new Date(AFTER.getTime() - 8 * DAY) }).where(eq(jobs.id, old.job.id));
      const recent = await put(p.userId);
      await db.update(jobs).set({ startAt: new Date(AFTER.getTime() - 3 * DAY - 6 * HOUR), endAt: new Date(AFTER.getTime() - 3 * DAY) }).where(eq(jobs.id, recent.job.id));
      await db.update(assignments).set({ status: "billed" }).where(eq(assignments.id, ended.a.id));
      await billingReadyTick(AFTER);
      const rows = await inbox(p.userId, "billing.ready");
      // only the job that ended 3 days ago: not 8 days ago, not canceled, not locked, not future
      expect(rows.map((r) => r.title)).toEqual([`Bill job #${recent.job.number}`]);
      expect(rows[0].link).toBe(`/jobs/${recent.job.id}`);
      expect((await db.select().from(assignments).where(eq(assignments.id, old.a.id)))[0].billReadyAlertedAt).toBeNull();
      await billingReadyTick(new Date(AFTER.getTime() + HOUR));
      expect(await inbox(p.userId, "billing.ready")).toHaveLength(1);
      const [mark] = await db.select().from(assignments).where(eq(assignments.id, locked.a.id));
      expect(mark.billReadyAlertedAt).toBeNull();
    });
  });

  describe("billing.ready for late cancellations", () => {
    test("a deputy owed late-cancel pay is told to bill it once the detail's end time passes", async () => {
      const p = await person();
      const { db } = get();
      const late = await put(p.userId, "late_canceled");
      await db.update(jobs).set({ state: "canceled", startAt: new Date(AFTER.getTime() - 2 * DAY - 6 * HOUR), endAt: new Date(AFTER.getTime() - 2 * DAY) }).where(eq(jobs.id, late.job.id));
      await billingReadyTick(AFTER);
      const rows = await inbox(p.userId, "billing.ready");
      expect(rows.map((r) => r.title)).toEqual([`Bill late cancellation pay for job #${late.job.number}`]);
      expect(rows[0].link).toBe(`/jobs/${late.job.id}`);
      await billingReadyTick(new Date(AFTER.getTime() + HOUR));
      expect(await inbox(p.userId, "billing.ready")).toHaveLength(1);
    });
  });

  describe("unbilled reminders", () => {
    test("invoices needing no action are not listed", async () => {
      const p = await person();
      const since = new Date(AFTER.getTime() - 40 * DAY);
      const mkInv = async () => {
        const { a } = await put(p.userId, "billed");
        const created = await tx((t) => createInvoice(t, { assignmentId: a.id, minutes: 360, rateCents: 7000, status: "sent" }));
        await get().db.update(invoices).set({ sentAt: since, vendorPaidAt: since }).where(eq(invoices.id, created.id));
        await tx((t) => applyResponsibility(t, created.id, since));
        return created.id;
      };
      const handled = await mkInv();
      await get().db.insert(paymentIssues).values({ invoiceId: handled, openedBy: p.userId, status: "open", waitingOn: "deputy" });
      await mkInv();
      const paid = await mkInv();
      await get().db.update(invoices).set({ deputyPaidAt: since }).where(eq(invoices.id, paid));
      await unbilledRemindersTick(AFTER);
      const [n] = await inbox(p.userId, "billing.unbilled_reminder");
      expect(n.body!.split("\n").filter((l) => l.startsWith("Confirm payment"))).toHaveLength(1);
    });

    test("one person failing does not stop the others", async () => {
      const bad = await person();
      const good = await person();
      await put(bad.userId);
      await put(good.userId);
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      const lockMod = await import("@/domain/billing/lock");
      const original = lockMod.loadUnbilled;
      const spy = vi.spyOn(lockMod, "loadUnbilled").mockImplementation(async (t, uid, n) => {
        if (uid === bad.userId) throw new Error("boom");
        return original(t, uid, n);
      });
      await unbilledRemindersTick(AFTER);
      spy.mockRestore();
      log.mockRestore();
      const total = (await inbox(bad.userId, "billing.unbilled_reminder")).length + (await inbox(good.userId, "billing.unbilled_reminder")).length;
      expect(total).toBe(1);
      expect(await inbox(good.userId, "billing.unbilled_reminder")).toHaveLength(1);
    });

    test("one reminder per person with items, respecting frequency, and none when nothing is owed", async () => {
      const busy = await person();
      const clear = await person();
      await put(busy.userId);
      await put(busy.userId);
      await put(clear.userId, "billed");

      await unbilledRemindersTick(AFTER);
      const first = await inbox(busy.userId, "billing.unbilled_reminder");
      expect(first).toHaveLength(1);
      expect(first[0].body).toContain("job #");
      expect(await inbox(clear.userId, "billing.unbilled_reminder")).toHaveLength(0);
      const [u] = await get().db.select().from(users).where(eq(users.id, busy.userId));
      expect(u.unbilledReminderSentAt!.getTime()).toBe(AFTER.getTime());

      await unbilledRemindersTick(new Date(AFTER.getTime() + HOUR));
      expect(await inbox(busy.userId, "billing.unbilled_reminder")).toHaveLength(1);
      // next agency day, even though under 24 hours later
      await unbilledRemindersTick(new Date(AFTER.getTime() + 23 * HOUR));
      expect(await inbox(busy.userId, "billing.unbilled_reminder")).toHaveLength(2);
    });

    test("an invoice waiting on the person's confirmation is listed", async () => {
      const p = await person();
      const { a } = await put(p.userId, "billed");
      const created = await tx((t) => createInvoice(t, { assignmentId: a.id, minutes: 360, rateCents: 7000, status: "sent" }));
      const since = new Date(AFTER.getTime() - 2 * DAY);
      await get().db.update(invoices).set({ sentAt: since, vendorPaidAt: since }).where(eq(invoices.id, created.id));
      await tx((t) => applyResponsibility(t, created.id, since));
      await unbilledRemindersTick(AFTER);
      const [n] = await inbox(p.userId, "billing.unbilled_reminder");
      expect(n.body).toContain("Confirm payment");
    });
  });
});
