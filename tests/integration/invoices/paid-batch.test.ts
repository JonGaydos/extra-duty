import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, invoices, paymentMethods, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment } from "@/domain/billing/bill";
import { markPaid } from "@/domain/billing/payments";
import { listInvoiceBatches, sendInvoiceBatch } from "@/domain/invoices/batch";
import { approveInvoice, sendBackInvoice } from "@/domain/invoices/review";
import { formatMoney } from "@/lib/pdf/invoice-pdf";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
const BILL = agencyInstant(2035, 12, 31, 9, 0);
const FRIDAY = agencyInstant(2036, 1, 4, 9, 0);
const pdfText = async (b: Buffer) => (await new PDFParse({ data: new Uint8Array(b) }).getText()).text;

describe("paid invoices in batches", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let methodId: string;

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "pbt");
    admin = (await makeUser(db, "admin", "pbt-admin@example.test")).actor;
    methodId = (await db.select().from(paymentMethods).where(eq(paymentMethods.active, true)).limit(1))[0].id;
  });

  beforeEach(async () => {
    const { db } = get();
    mail.clear();
    setEmailSender(mail);
    // Each test starts with an empty queue for the vendor.
    await db.update(invoices).set({ status: "written_off", readyAt: null }).where(eq(invoices.status, "ready_to_send"));
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"], invoiceSendSchedule: "weekly", emailApprovedInvoices: true }).where(eq(vendors.id, fx.vendorId));
    await db.transaction((tx) =>
      updateSettings(admin, tx, { email: GOOD_EMAIL, billingReplyToEmail: "billing@sheriff.example", invoiceReviewMode: "immediate", invoiceSendSchedule: "immediate", invoiceSendDayOfWeek: 5, waitForAllDeputies: false }),
    );
    await drain();
    mail.clear();
  });

  async function worked() {
    const { db } = get();
    const p = await fx.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
    const bill = (paid = false) => db.transaction((tx) => billAssignment(p, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false, ...(paid ? { paidOnSpot: { methodId, reference: "cash" } } : {}) }, BILL));
    return { p, a, job, bill };
  }
  const row = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0];
  const queuedIds = async () => (await get().db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY))).flatMap((b) => b.invoices.map((i) => i.id));

  test("a paid invoice in a batch is a Paid row that adds nothing to the total due, on the cover and in the email", async () => {
    const { db } = get();
    const unpaid = (await (await worked()).bill()).invoice;
    expect(unpaid.status).toBe("ready_to_send");
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "all" }));
    const spot = (await (await worked()).bill(true)).invoice;
    await db.transaction((tx) => approveInvoice(fx.coord, tx, spot.id, BILL, { send: true }));
    const batch = (await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY))).find((b) => b.vendorId === fx.vendorId)!;
    expect(batch.invoices.map((i) => [i.id, i.paid])).toEqual(expect.arrayContaining([[unpaid.id, false], [spot.id, true]]));
    expect(batch.totalCents).toBe(unpaid.totalCents);

    await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: false, missingW9: "send", includeWaiting: true, reason: "Test" }, FRIDAY));
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain(`Total due: ${formatMoney(unpaid.totalCents)}.`);
    expect(mail.sent[0].text).toContain("1 of them is already paid");
    const cover = await pdfText(mail.sent[0].attachments!.find((a) => a.filename.startsWith("Invoice summary"))!.content as Buffer);
    expect(cover).toMatch(/Paid/);
    expect(cover).toMatch(new RegExp(`Total due\\s*\\${formatMoney(unpaid.totalCents)}`));
  });

  test("paid on the spot and billed with no review for a batched vendor: closed as paid, queued, adds $0.00 to the batch", async () => {
    const { db } = get();
    const unpaid = (await (await worked()).bill()).invoice;
    const r = await (await worked()).bill(true);
    expect(r.delivery).toBe("ready_to_send");
    expect(r.invoice).toMatchObject({ status: "paid", paidSendQueued: true, sentAt: null, responsibleParty: null });
    expect(r.invoice.readyAt).not.toBeNull();
    const batch = (await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY))).find((b) => b.vendorId === fx.vendorId)!;
    expect(batch.invoices.find((i) => i.id === r.invoice.id)?.paid).toBe(true);
    expect(batch.totalCents).toBe(unpaid.totalCents);
    await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: false, missingW9: "send", includeWaiting: true, reason: "Test" }, FRIDAY));
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].text).toContain(`Total due: ${formatMoney(unpaid.totalCents)}.`);
    expect(await row(r.invoice.id)).toMatchObject({ status: "paid" });
  });

  test("an all-paid batch reads $0.00 due", async () => {
    const { db } = get();
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "all" }));
    const spot = (await (await worked()).bill(true)).invoice;
    await db.transaction((tx) => approveInvoice(fx.coord, tx, spot.id, BILL, { send: true }));
    await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: false, missingW9: "send", includeWaiting: true, reason: "Test" }, FRIDAY));
    await drain();
    expect(mail.sent[0].text).toContain("Total due: $0.00.");
  });

  test("sending back, re-billing, leaving unsent and marking paid all take an invoice out of the queue for good", async () => {
    const { db } = get();
    const w = await worked();
    const queued = (await w.bill()).invoice;
    expect((await row(queued.id)).readyAt).not.toBeNull();
    await db.transaction((tx) => sendBackInvoice(fx.coord, tx, queued.id, "Fix the hours", BILL));
    expect((await row(queued.id)).readyAt).toBeNull();

    // Re-billed, paid on the spot, to a vendor that does not get invoices by email: closed as paid, never queued.
    await db.update(vendors).set({ emailApprovedInvoices: false }).where(eq(vendors.id, fx.vendorId));
    const rebilled = (await w.bill(true)).invoice;
    expect(await row(rebilled.id)).toMatchObject({ status: "paid", readyAt: null, sentAt: null });
    expect(await queuedIds()).not.toContain(rebilled.id);

    // Unsent, then marked paid by the deputy.
    const u = await worked();
    const unsent = (await u.bill()).invoice;
    expect(await row(unsent.id)).toMatchObject({ status: "approved_unsent", readyAt: null });
    await db.transaction((tx) => markPaid(u.p, tx, unsent.id, { paymentMethodId: methodId, reference: "cash", paidAt: BILL }, FRIDAY));
    expect(await row(unsent.id)).toMatchObject({ status: "paid", readyAt: null, sentAt: null });
    expect(await queuedIds()).not.toContain(unsent.id);
  });

  test("an old row that is closed or unsent with a stale queued date is never picked up by a batch", async () => {
    const { db } = get();
    const a = (await (await worked()).bill()).invoice;
    const b = (await (await worked()).bill()).invoice;
    // Rows written before the fix: closed paid, and approved unsent, both still carrying a queued date.
    await db.update(invoices).set({ status: "paid", sentAt: null, readyAt: BILL }).where(eq(invoices.id, a.id));
    await db.update(invoices).set({ status: "approved_unsent", sentAt: null, readyAt: BILL }).where(eq(invoices.id, b.id));
    const ids = await queuedIds();
    expect(ids).not.toContain(a.id);
    expect(ids).not.toContain(b.id);
  });
});
