import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoiceEvents, invoices, paymentMethods, users, vendors, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment } from "@/domain/billing/bill";
import { coordinatorCloseInvoice, invoiceTimeline, markPaid } from "@/domain/billing/payments";
import { coordinatorTodo, staffInvoice, unsentInvoices } from "@/domain/coordinator/views";
import { ForbiddenError, RuleViolation } from "@/domain/errors";
import { listInvoiceBatches, sendInvoiceBatch } from "@/domain/invoices/batch";
import { approveInvoice, sendApprovedInvoice } from "@/domain/invoices/review";
import { myInvoices } from "@/domain/personnel/views";
import { isBilled } from "@/domain/reports/earnings";
import { runReport } from "@/domain/reports/engine";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { vendorInvoices } from "@/domain/vendor-portal/views";
import { updateVendor } from "@/domain/vendors/vendors";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
/** Mon Dec 31, 2035, agency time; Fridays are weekly send days. */
const BILL = agencyInstant(2035, 12, 31, 9, 0);
const LATER = agencyInstant(2036, 1, 2, 9, 0);
/** Fri Jan 4, 2036: a weekly send day. */
const FRIDAY = agencyInstant(2036, 1, 4, 9, 0);
const pdfText = async (b: Buffer) => (await new PDFParse({ data: new Uint8Array(b) }).getText()).text;

describe("approve without sending", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let vendorActor: Actor;

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "aus");
    admin = (await makeUser(db, "admin", "aus-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(inArray(vendors.id, [fx.vendorId, fx.otherVendorId]));
    const v = await makeUser(db, "vendor", "aus-vendor@example.test");
    await db.insert(vendorUsers).values({ userId: v.row.id, vendorId: fx.vendorId });
    vendorActor = { ...v.actor, vendorId: fx.vendorId };
  });

  beforeEach(async () => {
    const { db } = get();
    mail.clear();
    setEmailSender(mail);
    await db.update(vendors).set({ invoiceSendSchedule: null, emailApprovedInvoices: true });
    await db.transaction((tx) =>
      updateSettings(admin, tx, { email: GOOD_EMAIL, billingReplyToEmail: "billing@sheriff.example", invoiceReviewMode: "all", invoiceSendSchedule: "immediate", invoiceSendDayOfWeek: 5 }),
    );
    await drain();
    mail.clear();
  });

  /** A held invoice: a worked detail billed by a new deputy, waiting for review. */
  async function held(o: { vendor?: string } = {}) {
    const { db } = get();
    const p = await fx.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    const { job, positionId } = await fx.mkJob({ vendor: o.vendor });
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
    const { invoice } = await db.transaction((tx) => billAssignment(p, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, BILL));
    expect(invoice.status).toBe("pending_review");
    return { p, invoice };
  }
  const row = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0];
  const audits = (id: string, action: string) => get().db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));
  const invoiceJobs = async () => Number(((await get().db.execute(sql`select count(*)::int as n from pgboss.job where name = 'email.invoice'`)).rows[0] as { n: number }).n);

  test("Approve, don't send: no email, no batch, no vendor-visible event and nobody's clock", async () => {
    const { db } = get();
    const { invoice } = await held();
    const before = await invoiceJobs();
    const out = await db.transaction((tx) => approveInvoice(fx.coord, tx, invoice.id, BILL, { send: false }));
    expect(out.status).toBe("approved_unsent");
    expect(await invoiceJobs()).toBe(before);
    await drain();
    expect(mail.sent).toHaveLength(0);
    const r = await row(invoice.id);
    expect(r).toMatchObject({ status: "approved_unsent", sentAt: null, readyAt: null, batchId: null, emailStatus: "not_queued", responsibleParty: null });
    const events = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, invoice.id));
    expect(events.some((e) => e.vendorVisible)).toBe(false);
    expect(events.map((e) => e.event)).toContain("approved_unsent");
    // A batched vendor's unsent invoice does not join the batch queue either.
    await db.transaction((tx) => updateVendor(fx.coord, tx, fx.otherVendorId, { invoiceSendSchedule: "weekly" }));
    const other = await held({ vendor: fx.otherVendorId });
    expect((await db.transaction((tx) => approveInvoice(fx.coord, tx, other.invoice.id, BILL, { send: false }))).status).toBe("approved_unsent");
    const batches = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, LATER));
    expect(batches.flatMap((b) => b.invoices.map((i) => i.id))).not.toContain(other.invoice.id);
  });

  test("the vendor cannot see an unsent invoice", async () => {
    const { db } = get();
    const { invoice } = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, invoice.id, BILL, { send: false }));
    expect((await db.transaction((tx) => vendorInvoices(vendorActor, tx))).map((i) => i.id)).not.toContain(invoice.id);
    await expect(db.transaction((tx) => invoiceTimeline(vendorActor, tx, invoice.id))).rejects.toThrow(ForbiddenError);
  });

  test("Send now follows the normal send path: emailed at once, or batched on the vendor's schedule", async () => {
    const { db } = get();
    const { invoice } = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, invoice.id, BILL, { send: false }));
    const sent = await db.transaction((tx) => sendApprovedInvoice(fx.coord, tx, invoice.id, LATER));
    expect(sent.status).toBe("sent");
    expect(sent.sentAt?.getTime()).toBe(LATER.getTime());
    expect(sent.responsibleParty).toBe("vendor");
    await drain();
    expect(mail.sent.map((m) => m.to)).toEqual([["ap@vendor.example"]]);
    expect((await db.transaction((tx) => vendorInvoices(vendorActor, tx))).map((i) => i.id)).toContain(invoice.id);

    await db.transaction((tx) => updateVendor(fx.coord, tx, fx.otherVendorId, { invoiceSendSchedule: "weekly" }));
    const other = await held({ vendor: fx.otherVendorId });
    await db.transaction((tx) => approveInvoice(fx.coord, tx, other.invoice.id, BILL, { send: false }));
    const queued = await db.transaction((tx) => sendApprovedInvoice(fx.coord, tx, other.invoice.id, LATER));
    expect(queued.status).toBe("ready_to_send");
    const batches = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, LATER));
    expect(batches.find((b) => b.vendorId === fx.otherVendorId)?.invoices.map((i) => i.id)).toContain(other.invoice.id);

    // Only an approved, unsent invoice can be sent this way; personnel cannot.
    await expect(db.transaction((tx) => sendApprovedInvoice(fx.coord, tx, invoice.id, LATER))).rejects.toThrow(RuleViolation);
    const deputy = await fx.person();
    await expect(db.transaction((tx) => sendApprovedInvoice(deputy, tx, other.invoice.id, LATER))).rejects.toThrow(ForbiddenError);
  });

  test("the vendor's setting picks the default, and each approval can override it", async () => {
    const { db } = get();
    await db.transaction((tx) => updateVendor(fx.coord, tx, fx.vendorId, { emailApprovedInvoices: false }));
    const a = await held();
    const todo = await db.transaction((tx) => coordinatorTodo(fx.coord, tx, BILL));
    expect(todo.invoices.find((i) => i.id === a.invoice.id)?.sendByDefault).toBe(false);
    expect((await db.transaction((tx) => staffInvoice(fx.coord, tx, a.invoice.id, BILL))).sendByDefault).toBe(false);
    expect((await db.transaction((tx) => approveInvoice(fx.coord, tx, a.invoice.id, BILL))).status).toBe("approved_unsent");
    const b = await held();
    expect((await db.transaction((tx) => approveInvoice(fx.coord, tx, b.invoice.id, BILL, { send: true }))).status).toBe("sent");
    const [audit] = await audits(fx.vendorId, "vendor.update");
    expect(audit).toBeDefined();
  });

  test("the deputy sees an unsent invoice as not sent, can mark it paid, and it counts as billed", async () => {
    const { db } = get();
    const { p, invoice } = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, invoice.id, BILL, { send: false }));
    const mine = (await db.transaction((tx) => myInvoices(p, tx, LATER))).find((i) => i.id === invoice.id);
    expect(mine?.status).toBe("approved_unsent");
    expect(isBilled("approved_unsent")).toBe(true);
    // Staff can find it, to send it later.
    expect((await db.transaction((tx) => unsentInvoices(fx.coord, tx))).map((i) => i.id)).toContain(invoice.id);
    const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.active, true)).limit(1);
    const paid = await db.transaction((tx) => markPaid(p, tx, invoice.id, { paymentMethodId: method.id, reference: "cash", paidAt: BILL }, LATER));
    expect(paid.deputyPaidAt?.getTime()).toBe(BILL.getTime());
    expect(paid.status).toBe("paid");
  });

  test("the choice and the later send are both audited", async () => {
    const { db } = get();
    const { invoice } = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, invoice.id, BILL, { send: false }));
    const [approve] = await audits(invoice.id, "invoice.approve");
    expect(approve.before).toMatchObject({ status: "pending_review" });
    expect(approve.after).toMatchObject({ status: "approved_unsent", send: false });
    await db.transaction((tx) => sendApprovedInvoice(admin, tx, invoice.id, LATER));
    const [send] = await audits(invoice.id, "invoice.send");
    expect(send.actorUserId).toBe(admin.userId);
    expect(send.before).toMatchObject({ status: "approved_unsent" });
    expect(send.after).toMatchObject({ status: "sent" });
  });

  test("an invoice that skips review is approved, not sent, when the vendor's setting is off", async () => {
    const { db } = get();
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "immediate" }));
    await db.transaction((tx) => updateVendor(fx.coord, tx, fx.vendorId, { emailApprovedInvoices: false }));
    await db.transaction((tx) => updateVendor(fx.coord, tx, fx.otherVendorId, { emailApprovedInvoices: false, invoiceSendSchedule: "weekly" }));
    const ids: string[] = [];
    for (const vendor of [fx.vendorId, fx.otherVendorId]) {
      const p = await fx.person();
      await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
      const { job, positionId } = await fx.mkJob({ vendor });
      const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
      const before = await invoiceJobs();
      const r = await db.transaction((tx) => billAssignment(p, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, BILL));
      expect(r.delivery).toBe("approved_unsent");
      ids.push(r.invoice.id);
      expect(await row(r.invoice.id)).toMatchObject({ status: "approved_unsent", sentAt: null, readyAt: null, emailStatus: "not_queued", responsibleParty: null });
      expect(await invoiceJobs()).toBe(before);
      const events = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, r.invoice.id));
      expect(events.some((e) => e.vendorVisible)).toBe(false);
    }
    await drain();
    expect(mail.sent).toHaveLength(0);
    const batches = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, LATER));
    expect(batches.flatMap((b) => b.invoices.map((i) => i.id)).filter((id) => ids.includes(id))).toEqual([]);
  });

  test("an unsent invoice marked paid by the deputy, or closed by staff, closes without going to the vendor and drops out of outstanding", async () => {
    const { db } = get();
    const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.active, true)).limit(1);
    const outstanding = async (payeeUserId: string) =>
      (
        await db.transaction((tx) =>
          runReport(fx.coord, tx, { dataset: "invoices", from: agencyInstant(2035, 1, 1, 0, 0), to: agencyInstant(2036, 12, 31, 23, 59), filters: { userIds: [payeeUserId] }, groupBy: [], measures: ["billed_cents", "paid_cents", "outstanding_cents"] }, LATER),
        )
      ).totals;

    // The deputy marks it paid: closed as paid at once.
    const a = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, a.invoice.id, BILL, { send: false }));
    expect((await outstanding(a.p.userId)).outstanding_cents).toBe(a.invoice.totalCents);
    const paid = await db.transaction((tx) => markPaid(a.p, tx, a.invoice.id, { paymentMethodId: method.id, reference: "cash", paidAt: BILL }, LATER));
    expect(paid).toMatchObject({ status: "paid", sentAt: null, responsibleParty: null });
    expect((await db.select().from(assignments).where(eq(assignments.id, paid.assignmentId)))[0].status).toBe("paid");
    expect(await outstanding(a.p.userId)).toMatchObject({ billed_cents: a.invoice.totalCents, paid_cents: a.invoice.totalCents, outstanding_cents: 0 });
    // Never sent: no email, and the vendor never sees it.
    await drain();
    expect(mail.sent).toHaveLength(0);
    expect((await db.transaction((tx) => vendorInvoices(vendorActor, tx))).map((i) => i.id)).not.toContain(a.invoice.id);
    expect((await db.transaction((tx) => unsentInvoices(fx.coord, tx))).map((i) => i.id)).not.toContain(a.invoice.id);
    // Not sent; the paid version can still go to the vendor later if wanted.
    expect(await db.transaction((tx) => staffInvoice(fx.coord, tx, a.invoice.id, LATER))).toMatchObject({ canSendNow: false, canSendPaid: true });

    // Staff close one as paid and one as written off, without sending.
    const b = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, b.invoice.id, BILL, { send: false }));
    expect((await db.transaction((tx) => coordinatorCloseInvoice(fx.coord, tx, b.invoice.id, { outcome: "paid", reason: "Paid on the spot in cash" }, LATER))).status).toBe("paid");
    expect((await outstanding(b.p.userId)).outstanding_cents).toBe(0);
    const c = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, c.invoice.id, BILL, { send: false }));
    expect((await db.transaction((tx) => coordinatorCloseInvoice(admin, tx, c.invoice.id, { outcome: "written_off", reason: "Vendor closed" }, LATER))).status).toBe("written_off");
    expect(await outstanding(c.p.userId)).toMatchObject({ billed_cents: 0, outstanding_cents: 0 });
    for (const id of [b.invoice.id, c.invoice.id]) {
      const events = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, id));
      expect(events.some((e) => e.event === "sent")).toBe(false);
    }
    await drain();
    expect(mail.sent).toHaveLength(0);
  });

  describe("paid on the spot, then approved without sending", () => {
    const report = async (dataset: "invoices" | "payments", payeeUserId: string) =>
      (
        await get().db.transaction((tx) =>
          runReport(fx.coord, tx, { dataset, from: agencyInstant(2035, 1, 1, 0, 0), to: agencyInstant(2036, 12, 31, 23, 59), filters: { userIds: [payeeUserId] }, groupBy: [], measures: dataset === "invoices" ? ["billed_cents", "paid_cents", "outstanding_cents"] : ["count", "paid_cents"] }, LATER),
        )
      ).totals;
    async function spotBill(o: { review: boolean }) {
      const { db } = get();
      await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: o.review ? "all" : "immediate" }));
      const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.active, true)).limit(1);
      const p = await fx.person();
      await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
      const { job, positionId } = await fx.mkJob();
      const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
      const r = await db.transaction((tx) => billAssignment(p, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false, paidOnSpot: { methodId: method.id, reference: "cash" } }, BILL));
      return { p, a, r };
    }
    async function expectClosedPaid(invoiceId: string, assignmentId: string, payeeUserId: string, totalCents: number) {
      const { db } = get();
      expect(await row(invoiceId)).toMatchObject({ status: "paid", sentAt: null, emailStatus: "not_queued", responsibleParty: null });
      expect((await db.select().from(assignments).where(eq(assignments.id, assignmentId)))[0].status).toBe("paid");
      const events = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, invoiceId));
      expect(events.some((e) => e.vendorVisible)).toBe(false);
      expect(events.some((e) => e.event === "sent")).toBe(false);
      expect(await audits(invoiceId, "invoice.close")).toHaveLength(1);
      expect((await db.transaction((tx) => unsentInvoices(fx.coord, tx))).map((i) => i.id)).not.toContain(invoiceId);
      // The Invoices and Payments reports agree: billed, paid, nothing outstanding.
      expect(await report("invoices", payeeUserId)).toMatchObject({ billed_cents: totalCents, paid_cents: totalCents, outstanding_cents: 0 });
      expect(await report("payments", payeeUserId)).toMatchObject({ count: 1, paid_cents: totalCents });
      expect((await db.transaction((tx) => myInvoices({ userId: payeeUserId, role: "personnel", rankId: null, vendorId: null }, tx, LATER))).find((i) => i.id === invoiceId)?.status).toBe("paid");
      await drain();
      expect(mail.sent).toHaveLength(0);
    }

    test("billed paid on the spot to a vendor that does not get invoices by email closes as paid", async () => {
      const { db } = get();
      await db.transaction((tx) => updateVendor(fx.coord, tx, fx.vendorId, { emailApprovedInvoices: false }));
      const { p, a, r } = await spotBill({ review: false });
      await expectClosedPaid(r.invoice.id, a.id, p.userId, r.invoice.totalCents);
    });

    test("Approve, don't send on a paid-on-the-spot invoice closes it as paid", async () => {
      const { db } = get();
      const { p, a, r } = await spotBill({ review: true });
      expect(r.invoice.status).toBe("pending_review");
      expect((await db.transaction((tx) => approveInvoice(fx.coord, tx, r.invoice.id, BILL, { send: false }))).status).toBe("paid");
      await expectClosedPaid(r.invoice.id, a.id, p.userId, r.invoice.totalCents);
    });

    test("Approve and send on a paid-on-the-spot invoice sends it marked paid: closed, no timers, no responsibility events", async () => {
      const { db } = get();
      const { p, a, r } = await spotBill({ review: true });
      const since = new Date();
      const out = await db.transaction((tx) => approveInvoice(fx.coord, tx, r.invoice.id, BILL, { send: true }));
      expect(out).toMatchObject({ status: "paid", responsibleParty: null, responsibleSince: null });
      expect(out.sentAt?.getTime()).toBe(BILL.getTime());
      expect((await db.select().from(assignments).where(eq(assignments.id, a.id)))[0].status).toBe("paid");
      const events = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, r.invoice.id));
      const fresh = events.filter((e) => e.createdAt >= since);
      expect(fresh.filter((e) => e.event === "responsibility" && e.party !== null)).toEqual([]);
      expect(fresh.filter((e) => e.vendorVisible).map((e) => e.event)).toEqual(["sent"]);
      // The vendor sees it as paid; the reports have nothing outstanding.
      expect((await db.transaction((tx) => vendorInvoices(vendorActor, tx))).find((i) => i.id === r.invoice.id)?.status).toBe("paid");
      expect(await report("invoices", p.userId)).toMatchObject({ paid_cents: r.invoice.totalCents, outstanding_cents: 0 });
      // The email is the paid version of the invoice.
      await drain();
      expect(mail.sent).toHaveLength(1);
      const pdf = mail.sent[0].attachments!.find((x) => x.filename.endsWith(".pdf"))!;
      const text = await pdfText(pdf.content as Buffer);
      expect(text).toMatch(/PAID [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}, \d{4}/);
      expect(text).toContain("reference cash");
      expect(text).toMatch(/Amount due\s*\$0\.00/);
      expect((await row(r.invoice.id)).status).toBe("paid");
    });

    test("a paid invoice for a batched vendor waits for the batch and goes out still paid", async () => {
      const { db } = get();
      await db.transaction((tx) => updateVendor(fx.coord, tx, fx.vendorId, { invoiceSendSchedule: "weekly" }));
      const { r } = await spotBill({ review: true });
      const out = await db.transaction((tx) => approveInvoice(fx.coord, tx, r.invoice.id, BILL, { send: true }));
      expect(out).toMatchObject({ status: "paid", sentAt: null, responsibleParty: null });
      const batch = (await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY))).find((b) => b.vendorId === fx.vendorId)!;
      expect(batch.invoices.map((i) => i.id)).toContain(r.invoice.id);
      await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: false, missingW9: "send", includeWaiting: true, reason: "Test" }, FRIDAY));
      const sent = await row(r.invoice.id);
      expect(sent).toMatchObject({ status: "paid", responsibleParty: null });
      expect(sent.sentAt?.getTime()).toBe(FRIDAY.getTime());
      await drain();
      expect(await row(r.invoice.id)).toMatchObject({ status: "paid", emailStatus: "sent" });
    });

    test("Send paid invoice later: a paid invoice approved without sending can still be sent, once", async () => {
      const { db } = get();
      const { r } = await spotBill({ review: true });
      await db.transaction((tx) => approveInvoice(fx.coord, tx, r.invoice.id, BILL, { send: false }));
      const view = await db.transaction((tx) => staffInvoice(fx.coord, tx, r.invoice.id, LATER));
      expect(view).toMatchObject({ status: "paid", canSendNow: false, canSendPaid: true });
      const sent = await db.transaction((tx) => sendApprovedInvoice(fx.coord, tx, r.invoice.id, LATER));
      expect(sent.status).toBe("paid");
      expect(sent.sentAt?.getTime()).toBe(LATER.getTime());
      expect(await audits(r.invoice.id, "invoice.send")).toHaveLength(1);
      expect((await db.transaction((tx) => staffInvoice(fx.coord, tx, r.invoice.id, LATER))).canSendPaid).toBe(false);
      await expect(db.transaction((tx) => sendApprovedInvoice(fx.coord, tx, r.invoice.id, LATER))).rejects.toThrow(RuleViolation);
      await drain();
      expect(mail.sent).toHaveLength(1);
    });

    test("a written-off invoice offers no send and is refused; an unsent one with a stray paid date offers neither send", async () => {
      const { db } = get();
      const w = await held();
      await db.transaction((tx) => approveInvoice(fx.coord, tx, w.invoice.id, BILL, { send: false }));
      await db.transaction((tx) => coordinatorCloseInvoice(fx.coord, tx, w.invoice.id, { outcome: "written_off", reason: "Vendor closed" }, LATER));
      expect(await db.transaction((tx) => staffInvoice(fx.coord, tx, w.invoice.id, LATER))).toMatchObject({ canSendNow: false, canSendPaid: false });
      await expect(db.transaction((tx) => sendApprovedInvoice(fx.coord, tx, w.invoice.id, LATER))).rejects.toThrow(RuleViolation);
      // A stray unsent row with a paid date (data from before the fix) is neither sent as unpaid nor listed.
      const other = await held();
      await db.transaction((tx) => approveInvoice(fx.coord, tx, other.invoice.id, BILL, { send: false }));
      await db.update(invoices).set({ deputyPaidAt: BILL }).where(eq(invoices.id, other.invoice.id));
      expect((await db.transaction((tx) => unsentInvoices(fx.coord, tx))).map((i) => i.id)).not.toContain(other.invoice.id);
      expect(await db.transaction((tx) => staffInvoice(fx.coord, tx, other.invoice.id, LATER))).toMatchObject({ canSendNow: false, canSendPaid: false });
      await expect(db.transaction((tx) => sendApprovedInvoice(fx.coord, tx, other.invoice.id, LATER))).rejects.toThrow(RuleViolation);
    });
  });
});
