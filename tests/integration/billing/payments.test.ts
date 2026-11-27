import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoiceEvents, invoices, notifications, paymentIssues, paymentMethods } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { exportBillingCsv, billingHistory } from "@/domain/billing/history";
import {
  applyResponsibility,
  closeDeputyConfirmedInvoices,
  coordinatorCloseInvoice,
  invoiceTimeline,
  isOverdue,
  markPaid,
  paidLabel,
  paymentResponsibility,
  responsibleDueAt,
  vendorMarkPaid,
} from "@/domain/billing/payments";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { createInvoice } from "@/domain/invoices/invoices";
import { deriveJobStatus, loadJobStatus } from "@/domain/jobs/status";
import { byText } from "@/lib/sort";

const DAY = 86_400_000;

describe("paymentResponsibility (spec 12.10)", () => {
  const none = { deputyPaidAt: null, vendorPaidAt: null };
  const d = new Date();
  test.each([
    [{ status: "pending_review", ...none }, null, "coordinator"],
    [{ status: "returned", ...none }, null, "deputy"],
    [{ status: "paid", deputyPaidAt: d, vendorPaidAt: d }, null, null],
    [{ status: "written_off", ...none }, null, null],
    [{ status: "sent", ...none }, null, "vendor"],
    [{ status: "sent", deputyPaidAt: null, vendorPaidAt: d }, null, "deputy"],
    [{ status: "sent", deputyPaidAt: d, vendorPaidAt: null }, null, "vendor"],
    [{ status: "sent", ...none }, { waitingOn: "coordinator" }, "coordinator"],
    [{ status: "sent", ...none }, { waitingOn: "deputy" }, "deputy"],
    [{ status: "sent", deputyPaidAt: null, vendorPaidAt: d }, { waitingOn: "vendor" }, "vendor"],
    [{ status: "sent", ...none }, { waitingOn: null }, "coordinator"],
  ] as const)("%j with issue %j gives %s", (inv, issue, expected) => {
    expect(paymentResponsibility(inv as never, issue as never)).toBe(expected);
  });

  test("due date and overdue use responseDays", () => {
    const s = { responseDays: { vendor: 30, deputy: 30, coordinator: 7 } };
    const since = new Date("2035-03-01T12:00:00Z");
    expect(responsibleDueAt("coordinator", since, s).getTime()).toBe(since.getTime() + 7 * DAY);
    const inv = { responsibleParty: "coordinator" as const, responsibleSince: since };
    expect(isOverdue(inv, new Date(since.getTime() + 6 * DAY), s)).toBe(false);
    expect(isOverdue(inv, new Date(since.getTime() + 8 * DAY), s)).toBe(true);
    expect(isOverdue({ responsibleParty: null, responsibleSince: null }, new Date(), s)).toBe(false);
  });
});

describe("payment tracking", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let vendor: Actor;
  let otherVendor: Actor;
  let coord: Actor;
  let method: string;
  const NOW = new Date("2036-01-10T12:00:00Z");
  const PAID = new Date("2036-01-05T12:00:00Z");

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "pay");
    coord = fx.coord;
    vendor = { ...(await makeUser(db, "vendor", "pay-vendor@example.test")).actor, vendorId: fx.vendorId };
    otherVendor = { ...(await makeUser(db, "vendor", "pay-vendor2@example.test")).actor, vendorId: fx.otherVendorId };
    [{ id: method }] = await db.select({ id: paymentMethods.id }).from(paymentMethods).limit(1);
  });

  const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);

  async function mk(o: { status?: "sent" | "pending_review" | "returned"; minutes?: number; spot?: boolean; vendorId?: string } = {}) {
    const { db } = get();
    const person = await fx.person();
    const { job, positionId } = await fx.mkJob({ vendor: o.vendorId });
    const [a] = await db
      .insert(assignments)
      .values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "billed" })
      .returning();
    const status = o.status ?? "sent";
    const created = await tx((t) => createInvoice(t, { assignmentId: a.id, minutes: o.minutes ?? 360, rateCents: 7000, status }));
    if (status === "sent") await db.update(invoices).set({ sentAt: NOW }).where(eq(invoices.id, created.id));
    if (o.spot) await db.update(invoices).set({ deputyPaidAt: PAID, deputyMethodId: method, deputyReference: "cash" }).where(eq(invoices.id, created.id));
    await tx((t) => applyResponsibility(t, created.id, new Date(NOW.getTime() - 5 * DAY)));
    const inv = (await db.select().from(invoices).where(eq(invoices.id, created.id)))[0];
    return { inv, a, job, person };
  }
  const events = (id: string) => get().db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, id));
  const reload = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0];
  const pay = { paymentMethodId: "", reference: "1042", paidAt: PAID };

  test("a sent invoice starts as vendor; vendor mark moves it to deputy, then payee mark pays it", async () => {
    const { inv, person, a } = await mk();
    expect(inv.responsibleParty).toBe("vendor");
    const since = inv.responsibleSince!;

    await tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, paymentMethodId: method }, NOW));
    let cur = await reload(inv.id);
    expect(cur.status).toBe("sent");
    expect(cur.responsibleParty).toBe("deputy");
    expect(cur.responsibleSince!.getTime()).toBe(NOW.getTime());
    expect(cur.responsibleSince!.getTime()).not.toBe(since.getTime());
    expect(cur.vendorPaidReference).toBe("1042");
    const [n] = await get().db.select().from(notifications).where(and(eq(notifications.userId, person.userId), eq(notifications.title, "Vendor reports paid")));
    expect(n).toBeTruthy();

    await tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: method, note: "Check arrived" }, NOW));
    cur = await reload(inv.id);
    expect(cur.status).toBe("paid");
    expect(cur.responsibleParty).toBeNull();
    expect(cur.deputyPaidAt!.getTime()).toBe(PAID.getTime());
    const [asg] = await get().db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(asg.status).toBe("paid");
    const ev = await events(inv.id);
    expect(ev.find((e) => e.event === "deputy_paid")?.note).toBe("Check arrived");
    expect(ev.find((e) => e.event === "vendor_paid")?.note).toBeNull();
  });

  test("the deputy's confirmation closes the invoice as paid; no clock, overdue or reminder follows", async () => {
    const { inv, person, a } = await mk();
    expect(inv.responsibleParty).toBe("vendor");
    await tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: method }, NOW));
    const cur = await reload(inv.id);
    expect(cur.status).toBe("paid");
    expect(cur.closedByDeputy).toBe(true);
    expect(cur.vendorPaidAt).toBeNull();
    expect(cur.responsibleParty).toBeNull();
    expect(cur.responsibleSince).toBeNull();
    expect(paidLabel(cur)).toBe("Paid (confirmed by deputy)");
    expect((await get().db.select().from(assignments).where(eq(assignments.id, a.id)))[0].status).toBe("paid");
    // Nobody's turn, so it is never overdue and the daily tick has nothing to remind anyone of.
    expect(isOverdue(cur, new Date(NOW.getTime() + 90 * DAY), { responseDays: { vendor: 30, deputy: 30, coordinator: 7 } })).toBe(false);
    const ev = await events(inv.id);
    expect(ev.filter((e) => e.event === "responsibility").at(-1)?.party).toBeNull();
  });

  test("the vendor may still mark it paid later, for their records; it is on the timeline and alerts no one", async () => {
    const { inv, person } = await mk();
    await tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: method }, NOW));
    const later = new Date(NOW.getTime() + 3 * DAY);
    await tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, paymentMethodId: method, reference: "chk 88" }, later));
    const cur = await reload(inv.id);
    expect(cur.status).toBe("paid");
    expect(cur.vendorPaidReference).toBe("chk 88");
    expect(paidLabel(cur)).toBe("Paid");
    const vendorView = await tx((t) => invoiceTimeline(vendor, t, inv.id));
    expect(vendorView.map((e) => e.event)).toEqual(expect.arrayContaining(["deputy_paid", "vendor_paid"]));
    const alerts = await get().db.select().from(notifications).where(and(eq(notifications.userId, person.userId), eq(notifications.title, "Vendor reports paid")));
    expect(alerts).toHaveLength(0);
    await expect(tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, paymentMethodId: method }, later))).rejects.toThrow("You already marked this paid");
  });

  test("an invoice the coordinator closed as paid is not the vendor's to mark", async () => {
    const { inv } = await mk();
    await tx((t) => coordinatorCloseInvoice(coord, t, inv.id, { outcome: "paid", reason: "Paid at the office" }, NOW));
    await expect(tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(RuleViolation);
  });

  test("the release step closes invoices the deputy confirmed under the old rule, once, with a system audit entry", async () => {
    const { db } = get();
    const old = await mk();
    // The old two-sided rule: deputy confirmed, vendor never did, still sent and the vendor's turn.
    await db.update(invoices).set({ deputyPaidAt: PAID, deputyMethodId: method }).where(eq(invoices.id, old.inv.id));
    await db.insert(paymentIssues).values({ invoiceId: old.inv.id, openedBy: old.person.userId, waitingOn: "vendor" });
    const untouched = await mk();
    const closed = await tx((t) => closeDeputyConfirmedInvoices(t, NOW));
    expect(closed).toBeGreaterThanOrEqual(1);
    const cur = await reload(old.inv.id);
    expect(cur).toMatchObject({ status: "paid", closedByDeputy: true, responsibleParty: null });
    expect((await db.select().from(assignments).where(eq(assignments.id, old.a.id)))[0].status).toBe("paid");
    expect((await db.select().from(paymentIssues).where(eq(paymentIssues.invoiceId, old.inv.id)))[0].status).toBe("paid");
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, old.inv.id), eq(auditLog.action, "invoice.close")));
    expect(audit).toHaveLength(1);
    expect(audit[0].actorUserId).toBeNull();
    expect(audit[0].reason).toMatch(/deputy's payment confirmation closes the invoice/);
    expect((await reload(untouched.inv.id)).status).toBe("sent");
    // Running it again changes nothing.
    expect(await tx((t) => closeDeputyConfirmedInvoices(t, NOW))).toBe(0);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, old.inv.id), eq(auditLog.action, "invoice.close")))).toHaveLength(1);
  });

  test("applyResponsibility writes one event only when the party changes", async () => {
    const { inv } = await mk();
    const n = (await events(inv.id)).length;
    await tx((t) => applyResponsibility(t, inv.id, new Date(NOW.getTime() + DAY)));
    expect(await events(inv.id)).toHaveLength(n);
    expect((await events(inv.id)).some((e) => e.event === "responsibility" && e.party === "vendor")).toBe(true);
  });

  test("refusals: other vendor, other person, double marks, held invoices, future date, bad method", async () => {
    const { inv, person } = await mk();
    const other = await fx.person();
    await expect(tx((t) => vendorMarkPaid(otherVendor, t, inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => markPaid(other, t, inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: method, paidAt: new Date(NOW.getTime() + DAY) }, NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: "nope" }, NOW))).rejects.toBeInstanceOf(ValidationError);
    await tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, paymentMethodId: method }, NOW));
    await expect(tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(RuleViolation);
    await tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: method }, NOW));
    await expect(tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(RuleViolation);

    const spot = await mk({ spot: true });
    await expect(tx((t) => markPaid(spot.person, t, spot.inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(RuleViolation);

    for (const status of ["pending_review", "returned"] as const) {
      const h = await mk({ status });
      await expect(tx((t) => markPaid(h.person, t, h.inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(RuleViolation);
      await expect(tx((t) => vendorMarkPaid(vendor, t, h.inv.id, { ...pay, paymentMethodId: method }, NOW))).rejects.toBeInstanceOf(RuleViolation);
    }
  });

  test("a paid mark closes open issues as paid", async () => {
    const { inv, person } = await mk();
    await get().db.insert(paymentIssues).values({ invoiceId: inv.id, openedBy: person.userId, waitingOn: "vendor" });
    expect((await reload(inv.id)).responsibleParty).toBe("vendor");
    await tx((t) => applyResponsibility(t, inv.id, NOW));
    await tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, paymentMethodId: method }, NOW));
    await tx((t) => markPaid(person, t, inv.id, { ...pay, paymentMethodId: method }, NOW));
    const [issue] = await get().db.select().from(paymentIssues).where(eq(paymentIssues.invoiceId, inv.id));
    expect(issue.status).toBe("paid");
  });

  test("coordinatorCloseInvoice: reason required, paid and written off, vendor cannot see the reason", async () => {
    const a = await mk();
    await expect(tx((t) => coordinatorCloseInvoice(coord, t, a.inv.id, { outcome: "paid", reason: "  " }, NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(tx((t) => coordinatorCloseInvoice(a.person, t, a.inv.id, { outcome: "paid", reason: "x" }, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await tx((t) => coordinatorCloseInvoice(coord, t, a.inv.id, { outcome: "paid", reason: "Vendor never logs in" }, NOW));
    const paid = await reload(a.inv.id);
    expect(paid.status).toBe("paid");
    expect(paid.closedReason).toBe("Vendor never logs in");
    expect(paid.responsibleParty).toBeNull();
    expect((await get().db.select().from(assignments).where(eq(assignments.id, a.a.id)))[0].status).toBe("paid");

    const b = await mk();
    await tx((t) => coordinatorCloseInvoice(coord, t, b.inv.id, { outcome: "written_off", reason: "Vendor closed" }, NOW));
    expect((await reload(b.inv.id)).status).toBe("written_off");
    expect((await get().db.select().from(assignments).where(eq(assignments.id, b.a.id)))[0].status).toBe("billed");

    const forCoord = await tx((t) => invoiceTimeline(coord, t, b.inv.id));
    const forVendor = await tx((t) => invoiceTimeline(vendor, t, b.inv.id));
    const forPayee = await tx((t) => invoiceTimeline(b.person, t, b.inv.id));
    expect(forCoord.some((e) => e.note === "Vendor closed")).toBe(true);
    expect(forVendor.some((e) => e.note === "Vendor closed")).toBe(false);
    expect(forVendor.some((e) => e.event === "closed_written_off")).toBe(true);
    expect(forPayee.length).toBeGreaterThan(0);
  });

  test("timeline access: payee, vendor of the invoice, coordinators only", async () => {
    const { inv } = await mk();
    const other = await fx.person();
    await expect(tx((t) => invoiceTimeline(other, t, inv.id))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => invoiceTimeline(otherVendor, t, inv.id))).rejects.toBeInstanceOf(ForbiddenError);
    const ev = await tx((t) => invoiceTimeline(vendor, t, inv.id));
    expect(ev.length).toBeGreaterThan(0);
    for (const e of ev) expect(Object.keys(e).sort(byText)).toEqual(["at", "event", "id", "invoiceId", "note", "party"]);
  });

  test("a vendor cannot read the timeline before the invoice was sent", async () => {
    const held = await mk({ status: "pending_review" });
    await expect(tx((t) => invoiceTimeline(vendor, t, held.inv.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await tx((t) => invoiceTimeline(coord, t, held.inv.id))).length).toBeGreaterThan(0);
  });

  test("a job closes when every invoice is paid or written off", async () => {
    const { db } = get();
    const person = await fx.person();
    const person2 = await fx.person();
    const { job, positionId } = await fx.mkJob({ count: 2 });
    const asg = await db
      .insert(assignments)
      .values([person, person2].map((p) => ({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "billed" as const })))
      .returning();
    const invs: Awaited<ReturnType<typeof createInvoice>>[] = [];
    for (const a of asg) invs.push(await tx((t) => createInvoice(t, { assignmentId: a.id, minutes: 360, rateCents: 7000, status: "sent" })));
    for (const i of invs) await tx((t) => applyResponsibility(t, i.id, NOW));
    const status = async () => {
      const as = await db.select().from(assignments).where(eq(assignments.jobId, job.id));
      const is = await db.select().from(invoices).where(eq(invoices.vendorId, fx.vendorId));
      const mine = is.filter((i) => as.some((a) => a.id === i.assignmentId));
      return deriveJobStatus(
        { state: "active", held: false, releaseAt: new Date(0), startAt: job.startAt, endAt: job.endAt, vendorOnPaymentHold: false, spots: 2 },
        as.map((a) => ({ id: a.id, status: a.status })),
        mine.map((i) => ({ assignmentId: i.assignmentId, status: i.status })),
        new Date("2036-06-01T00:00:00Z"),
      );
    };
    expect(await status()).toBe("billed");
    await tx((t) => coordinatorCloseInvoice(coord, t, invs[0].id, { outcome: "paid", reason: "ok" }, NOW));
    await tx((t) => coordinatorCloseInvoice(coord, t, invs[1].id, { outcome: "written_off", reason: "ok" }, NOW));
    expect(await status()).toBe("closed");
  });

  test("loadJobStatus reads a detail's status from the database: ready to bill, billed, then closed", async () => {
    const { db } = get();
    const person = await fx.person();
    const { job, positionId } = await fx.mkJob();
    const after = new Date(job.endAt.getTime() + DAY);
    const load = () => tx((t) => loadJobStatus(t, job.id, after));
    expect(await tx((t) => loadJobStatus(t, job.id, new Date(job.startAt.getTime() - DAY)))).toBe("open");
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "signed_up" }).returning();
    expect(await load()).toBe("ready_to_bill");
    await db.update(assignments).set({ status: "billed" }).where(eq(assignments.id, a.id));
    const inv = await tx((t) => createInvoice(t, { assignmentId: a.id, minutes: 240, rateCents: 7000, status: "sent" }));
    expect(await load()).toBe("billed");
    await tx((t) => coordinatorCloseInvoice(coord, t, inv.id, { outcome: "paid", reason: "Paid by check" }, NOW));
    expect(await load()).toBe("closed");
  });
});

describe("billing history", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let coord: Actor;
  let vendor: Actor;
  let person: Actor;
  let other: Actor;
  const NOW = new Date("2036-01-10T12:00:00Z");

  async function inv(p: Actor, o: { status: "sent" | "paid" | "pending_review" | "returned" | "written_off"; minutes: number; vendorId?: string; day?: number }) {
    const { db } = get();
    const { job, positionId } = await fx.mkJob({ vendor: o.vendorId });
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "billed" }).returning();
    const created = await get().db.transaction((t) => createInvoice(t, { assignmentId: a.id, minutes: o.minutes, rateCents: 7500, status: o.status }));
    if (o.status === "paid") await db.update(invoices).set({ deputyPaidAt: NOW, vendorPaidAt: NOW, deputyReference: "=cmd", vendorPaidReference: "r" }).where(eq(invoices.id, created.id));
    return { created, job };
  }

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "hist");
    coord = fx.coord;
    vendor = { ...(await makeUser(db, "vendor", "hist-vendor@example.test")).actor, vendorId: fx.vendorId };
    person = await fx.person();
    other = await fx.person();
    // 45000 paid (360 min), 48750 sent (390 min), 60000 pending (480 min), plus excluded rows.
    await inv(person, { status: "paid", minutes: 360 });
    await inv(person, { status: "sent", minutes: 390 });
    await inv(person, { status: "pending_review", minutes: 480 });
    await inv(person, { status: "written_off", minutes: 240 });
    await inv(person, { status: "returned", minutes: 240 });
    await inv(other, { status: "sent", minutes: 240, vendorId: fx.otherVendorId });
  });

  test("totals for the sample set; written off and returned excluded", async () => {
    const h = await get().db.transaction((t) => billingHistory(person, t, {}));
    expect(h.totals).toMatchObject({ earnedCents: 153750, paidCents: 45000, waitingCents: 108750 });
    expect(h.rows).toHaveLength(5);
    expect(h.rows.map((r) => r.status).sort(byText)).toEqual(["paid", "pending_review", "returned", "sent", "written_off"]);
    expect(h.byMonth.reduce((n, m) => n + m.earnedCents, 0)).toBe(153750);
    expect(h.byMonth[0].month).toMatch(/^\d{4}-\d{2}$/);
  });

  test("access: own only, coordinators anyone, vendors refused, filters", async () => {
    const own = await get().db.transaction((t) => billingHistory(other, t, {}));
    expect(own.rows).toHaveLength(1);
    await expect(get().db.transaction((t) => billingHistory(other, t, { payeeUserId: person.userId }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(get().db.transaction((t) => billingHistory(vendor, t, {}))).rejects.toBeInstanceOf(ForbiddenError);
    const forPerson = await get().db.transaction((t) => billingHistory(coord, t, { payeeUserId: person.userId }));
    expect(forPerson.rows).toHaveLength(5);
    const byVendor = await get().db.transaction((t) => billingHistory(coord, t, { vendorId: fx.otherVendorId }));
    expect(byVendor.rows).toHaveLength(1);
    const none = await get().db.transaction((t) => billingHistory(coord, t, { from: new Date("2040-01-01"), to: new Date("2041-01-01") }));
    expect(none.rows).toHaveLength(0);
  });

  test("CSV has a header, one row per invoice, plain money and formula-safe cells", async () => {
    const csv = await get().db.transaction((t) => exportBillingCsv(person, t, {}));
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Invoice,Job,Vendor,Job date,Minutes,Rate,Total,Status,Deputy paid,Vendor paid,Reference");
    expect(lines).toHaveLength(6);
    expect(csv).toContain("450.00");
    expect(csv).toContain("75.00");
    expect(csv).toContain("'=cmd");
    expect(csv).not.toContain("$");
    expect(lines[1]).toMatch(/^[A-Z-]*\d{6},\d+,/);
  });
});
