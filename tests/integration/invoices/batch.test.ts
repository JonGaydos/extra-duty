import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoiceBatches, invoiceEvents, invoices, jobs, notifications, paymentMethods, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment } from "@/domain/billing/bill";
import { coordinatorTodo, staffInvoice } from "@/domain/coordinator/views";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { invoiceBatchesDueTick, listInvoiceBatches, sendInvoiceBatch, setWaitForAllDeputies, waitingText } from "@/domain/invoices/batch";
import { approveInvoice, editInvoice, sendBackInvoice } from "@/domain/invoices/review";
import { myInvoices } from "@/domain/personnel/views";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { updateVendor } from "@/domain/vendors/vendors";
import { uploadW9 } from "@/domain/w9/w9";
import { invoiceTimeline, vendorMarkPaid } from "@/domain/billing/payments";
import { deliverInvoiceBatchEmail, redactProviderError } from "@/domain/invoices/batch";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

/** A made-up provider key, built in pieces so secret scanners do not mistake it for a real one. */
const FAKE_PROVIDER_KEY = ["sk", "live", "4f9a8b7c6d5e4f3a2b1c0d9e"].join("_");

const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
const W9_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("w9 form body ".repeat(20))]);
/** Mon Dec 31, 2035, agency time. Fridays are send days, so this batch is due Fri Jan 4, 2036. */
const BILL = agencyInstant(2035, 12, 31, 9, 0);
const WEDNESDAY = agencyInstant(2036, 1, 2, 9, 0);
const FRIDAY = agencyInstant(2036, 1, 4, 9, 0);

const pdfText = async (b: Buffer) => (await new PDFParse({ data: new Uint8Array(b) }).getText()).text;

describe("batched invoice sending", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-batch-"));
    fx = await setupFixture(db, "bat");
    admin = (await makeUser(db, "admin", "bat-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(inArray(vendors.id, [fx.vendorId, fx.otherVendorId]));
  });

  beforeEach(async () => {
    const { db } = get();
    mail.clear();
    setEmailSender(mail);
    // Every earlier test's queue is cleared so each test sees only its own batches.
    // (No queued date, so they are not paid invoices waiting to go out marked paid.)
    await db.update(invoices).set({ status: "paid", readyAt: null }).where(eq(invoices.status, "ready_to_send"));
    // Paid invoices queued to go out marked paid (paid on the spot) are taken off the queue too.
    await db.update(invoices).set({ paidSendQueued: false, readyAt: null }).where(and(eq(invoices.status, "paid"), eq(invoices.paidSendQueued, true)));
    await db.update(vendors).set({ invoiceSendSchedule: null });
    await db.transaction((tx) =>
      updateSettings(admin, tx, {
        email: GOOD_EMAIL,
        billingReplyToEmail: "billing@sheriff.example",
        invoiceReviewMode: "immediate",
        invoiceSendSchedule: "weekly",
        invoiceSendDayOfWeek: 5,
        waitForAllDeputies: true,
      }),
    );
    await drain();
    mail.clear();
  });

  async function person(name: string) {
    const { db } = get();
    const p = await fx.person();
    await db.update(users).set({ name, mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    return p;
  }

  /** A worked job (17:00 to 23:00) with `count` spots; each listed person signed up. */
  async function detail(people: Actor[], o: { vendor?: string } = {}) {
    const { db } = get();
    const { job, positionId } = await fx.mkJob({ count: Math.max(1, people.length), vendor: o.vendor });
    const rows = [];
    for (const p of people) {
      const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
      rows.push(a);
    }
    return { job, rows };
  }

  async function bill(p: Actor, assignmentId: string, job: { startAt: Date; endAt: Date }, attachW9 = false, now = BILL) {
    return (await get().db.transaction((tx) => billAssignment(p, tx, assignmentId, { startAt: job.startAt, endAt: job.endAt, attachW9 }, now))).invoice;
  }

  const row = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0];

  test("in a batch mode a billed invoice waits as ready to send: no email, no sent date and no vendor clock", async () => {
    const p = await person("Avery Queue");
    const { job, rows } = await detail([p]);
    const inv = await bill(p, rows[0].id, job);
    await drain();
    expect(mail.sent).toHaveLength(0);
    const r = await row(inv.id);
    expect(r.status).toBe("ready_to_send");
    expect(r.sentAt).toBeNull();
    expect(r.readyAt?.getTime()).toBe(BILL.getTime());
    expect(r.emailStatus).toBe("not_queued");
    expect(r.responsibleParty).toBeNull();
    // A vendor cannot see it yet.
    const events = await get().db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, inv.id));
    expect(events.some((e) => e.vendorVisible)).toBe(false);
  });

  test("a held invoice approved in a batch mode joins the queue instead of being emailed", async () => {
    const { db } = get();
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "all" }));
    const p = await person("Blake Held");
    const { job, rows } = await detail([p]);
    const inv = await bill(p, rows[0].id, job);
    expect(inv.status).toBe("pending_review");
    const approved = await db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, BILL));
    await drain();
    expect(approved.status).toBe("ready_to_send");
    expect(approved.sentAt).toBeNull();
    expect(mail.sent).toHaveLength(0);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, inv.id), eq(auditLog.action, "invoice.approve")));
    expect(audit).toHaveLength(1);
  });

  test("a vendor override wins over the agency schedule", async () => {
    const { db } = get();
    await db.transaction((tx) => updateVendor(fx.coord, tx, fx.otherVendorId, { invoiceSendSchedule: "immediate" }));
    const p = await person("Casey Override");
    const { job, rows } = await detail([p], { vendor: fx.otherVendorId });
    const inv = await bill(p, rows[0].id, job);
    expect(inv.status).toBe("sent");
    await drain();
    expect(mail.sent).toHaveLength(1);

    mail.clear();
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceSendSchedule: "immediate" }));
    await db.transaction((tx) => updateVendor(fx.coord, tx, fx.vendorId, { invoiceSendSchedule: "monthly" }));
    const q = await person("Casey Monthly");
    const d2 = await detail([q]);
    expect((await bill(q, d2.rows[0].id, d2.job)).status).toBe("ready_to_send");
    const vendorAudit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, fx.vendorId), eq(auditLog.action, "vendor.update")));
    expect(vendorAudit.length).toBeGreaterThan(0);
  });

  test("the batch list groups by vendor with its send day; the to-do shows it from that day", async () => {
    const { db } = get();
    const p = await person("Drew Listed");
    const q = await person("Ellis Listed");
    const d1 = await detail([p]);
    const d2 = await detail([q]);
    const i1 = await bill(p, d1.rows[0].id, d1.job);
    const i2 = await bill(q, d2.rows[0].id, d2.job);
    const batches = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, WEDNESDAY));
    expect(batches).toHaveLength(1);
    const b = batches[0];
    expect(b.vendorId).toBe(fx.vendorId);
    expect(b.schedule).toBe("weekly");
    expect(b.sendDay).toBe("2036-01-04");
    expect(b.due).toBe(false);
    expect(b.invoices.map((i) => i.id).sort()).toEqual([i1.id, i2.id].sort());
    expect(b.totalCents).toBe(i1.totalCents + i2.totalCents);

    expect((await db.transaction((tx) => coordinatorTodo(fx.coord, tx, WEDNESDAY))).sendInvoices).toHaveLength(0);
    const todo = await db.transaction((tx) => coordinatorTodo(fx.coord, tx, FRIDAY));
    expect(todo.sendInvoices.map((s) => s.vendorId)).toEqual([fx.vendorId]);
    expect(todo.sendInvoices[0].due).toBe(true);
  });

  test("sending a due batch emails the vendor once with a cover summary and every invoice, and starts the vendor clock at send", async () => {
    const { db } = get();
    const p = await person("Frankie Sent");
    const q = await person("Gray Sent");
    const d1 = await detail([p]);
    const d2 = await detail([q]);
    const i1 = await bill(p, d1.rows[0].id, d1.job);
    const i2 = await bill(q, d2.rows[0].id, d2.job);
    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: false, missingW9: "send", includeWaiting: false }, FRIDAY));
    expect(r.sent).toBe(2);
    await drain();
    expect(mail.sent).toHaveLength(1);
    const msg = mail.sent[0];
    expect(msg.to).toEqual(["ap@vendor.example"]);
    const names = msg.attachments!.map((a) => a.filename);
    const n1 = `ED-${String(i1.number).padStart(6, "0")}`;
    const n2 = `ED-${String(i2.number).padStart(6, "0")}`;
    expect(names).toEqual(expect.arrayContaining([`${n1}.pdf`, `${n2}.pdf`]));
    expect(names).toHaveLength(3);
    const cover = msg.attachments!.find((a) => a.filename.startsWith("Invoice summary"))!;
    const text = await pdfText(cover.content as Buffer);
    expect(text).toContain(n1);
    expect(text).toContain(n2);
    expect(text).toContain("Frankie Sent");
    expect(text).toContain("Total");
    expect(text).toContain("$840.00");
    expect(text).not.toMatch(/agency range/i);
    expect(msg.text).not.toMatch(/agency range/i);

    for (const id of [i1.id, i2.id]) {
      const inv = await row(id);
      expect(inv.status).toBe("sent");
      expect(inv.sentAt?.getTime()).toBe(FRIDAY.getTime());
      expect(inv.responsibleParty).toBe("vendor");
      expect(inv.responsibleSince?.getTime()).toBe(FRIDAY.getTime());
      expect(inv.emailStatus).toBe("sent");
      expect(inv.batchId).toBe(r.batchId);
      const sent = await db.select().from(invoiceEvents).where(and(eq(invoiceEvents.invoiceId, id), eq(invoiceEvents.event, "sent")));
      expect(sent).toHaveLength(1);
      expect(sent[0].vendorVisible).toBe(true);
    }
    const [batch] = await db.select().from(invoiceBatches).where(eq(invoiceBatches.id, r.batchId));
    expect(batch.emailStatus).toBe("sent");
    expect(batch.earlyReason).toBeNull();
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityId, r.batchId), eq(auditLog.action, "invoice_batch.send")));
    expect(audit).toHaveLength(1);
    expect(await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY))).toHaveLength(0);
  });

  test("sending before the send day needs a reason, which is kept and audited", async () => {
    const { db } = get();
    const p = await person("Harper Early");
    const d = await detail([p]);
    await bill(p, d.rows[0].id, d.job);
    const input = { attachW9ForAll: false, missingW9: "send" as const, includeWaiting: false };
    await expect(db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, input, WEDNESDAY))).rejects.toThrow("Give a reason for sending early.");
    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { ...input, reason: "Vendor closes its books Friday" }, WEDNESDAY));
    const [batch] = await db.select().from(invoiceBatches).where(eq(invoiceBatches.id, r.batchId));
    expect(batch.earlyReason).toBe("Vendor closes its books Friday");
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, r.batchId), eq(auditLog.action, "invoice_batch.send")));
    expect(audit.reason).toBe("Vendor closes its books Friday");
  });

  test("wait for all deputies holds a detail until everyone bills, names who is left, and can be sent early or turned off per detail", async () => {
    const { db } = get();
    const p = await person("Indy Billed");
    const q = await person("Jordan Waiting");
    const d = await detail([p, q]);
    const i1 = await bill(p, d.rows[0].id, d.job);
    let [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.waiting).toEqual([{ jobId: d.job.id, jobNumber: d.job.number, jobTitle: d.job.title, names: ["Jordan Waiting"], inReview: [] }]);
    expect(waitingText(b.waiting[0])).toBe("Waiting on 1 deputy to bill (Jordan Waiting)");
    expect(b.invoices.find((i) => i.id === i1.id)?.waiting).toBe(true);
    expect(b.totalCents).toBe(0);
    const input = { attachW9ForAll: false, missingW9: "send" as const, includeWaiting: false };
    await expect(db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, input, FRIDAY))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { ...input, includeWaiting: true }, FRIDAY))).rejects.toThrow("Give a reason for sending early.");

    // A removed or no-show deputy counts as resolved.
    await db.update(assignments).set({ status: "no_show" }).where(eq(assignments.id, d.rows[1].id));
    [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.waiting).toEqual([]);
    await db.update(assignments).set({ status: "signed_up" }).where(eq(assignments.id, d.rows[1].id));

    // The detail's own setting wins over the agency's, and the change is audited.
    await db.transaction((tx) => setWaitForAllDeputies(fx.coord, tx, d.job.id, false));
    [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.waiting).toEqual([]);
    expect((await db.select().from(jobs).where(eq(jobs.id, d.job.id)))[0].waitForAllDeputies).toBe(false);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, d.job.id), eq(auditLog.action, "job.wait_for_all_deputies")))).toHaveLength(1);
    await db.transaction((tx) => setWaitForAllDeputies(fx.coord, tx, d.job.id, null));

    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { ...input, includeWaiting: true, reason: "Vendor asked for it now" }, FRIDAY));
    expect(r.sent).toBe(1);
    expect((await row(i1.id)).status).toBe("sent");
  });

  test("wait for all deputies also holds a detail while one of its invoices is still in review, and says so", async () => {
    const { db } = get();
    const p = await person("Sasha Ready");
    const q = await person("Toby Review");
    const d = await detail([p, q]);
    const i1 = await bill(p, d.rows[0].id, d.job);
    const i2 = await bill(q, d.rows[1].id, d.job);
    await db.update(invoices).set({ status: "pending_review", readyAt: null }).where(eq(invoices.id, i2.id));
    let [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.waiting).toEqual([{ jobId: d.job.id, jobNumber: d.job.number, jobTitle: d.job.title, names: [], inReview: ["Toby Review"] }]);
    expect(waitingText(b.waiting[0])).toBe("Waiting on 1 invoice in review (Toby Review)");
    expect(b.invoices.find((i) => i.id === i1.id)?.waiting).toBe(true);
    const todo = await db.transaction((tx) => coordinatorTodo(fx.coord, tx, FRIDAY));
    expect(todo.sendInvoices[0].waiting[0].inReview).toEqual(["Toby Review"]);

    // Once it is approved the detail's invoices go together.
    await db.transaction((tx) => approveInvoice(fx.coord, tx, i2.id, BILL));
    [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.waiting).toEqual([]);
    expect(b.invoices.map((i) => i.id).sort()).toEqual([i1.id, i2.id].sort());
  });

  test("an invoice in review can still be sent early with a reason, leaving the one in review behind", async () => {
    const { db } = get();
    const p = await person("Uma Ready");
    const q = await person("Vic Review");
    const d = await detail([p, q]);
    const i1 = await bill(p, d.rows[0].id, d.job);
    const i2 = await bill(q, d.rows[1].id, d.job);
    await db.update(invoices).set({ status: "pending_review", readyAt: null }).where(eq(invoices.id, i2.id));
    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: false, missingW9: "send", includeWaiting: true, reason: "Vendor pays the first today" }, FRIDAY));
    expect(r.sent).toBe(1);
    expect((await row(i1.id)).status).toBe("sent");
    expect((await row(i2.id)).status).toBe("pending_review");
  });

  test("attach W-9s for every deputy: current W-9s go out, each read audited as the coordinator; a deputy with none is listed and can be held", async () => {
    const { db } = get();
    const withW9 = await person("Kai Has W9");
    const without = await person("Lee No W9");
    await db.transaction((tx) => uploadW9(withW9, tx, W9_PDF, "w9.pdf"));
    const d1 = await detail([withW9]);
    const d2 = await detail([without]);
    const i1 = await bill(withW9, d1.rows[0].id, d1.job);
    const i2 = await bill(without, d2.rows[0].id, d2.job);
    const [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.missingW9).toEqual([{ userId: without.userId, name: "Lee No W9" }]);

    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: true, missingW9: "hold", includeWaiting: false }, FRIDAY));
    expect(r.sent).toBe(1);
    expect(r.held).toBe(1);
    expect((await row(i2.id)).status).toBe("ready_to_send");
    const sent = await row(i1.id);
    expect(sent.attachW9).toBe(true);
    expect(sent.w9RequestedBy).toBe(fx.coord.userId);
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].attachments!.map((a) => a.filename)).toContain("W-9 Kai Has W9.pdf");
    const reads = await db.execute(sql`select actor_user_id from audit_log where action = 'w9.read' and after->>'invoiceId' = ${i1.id}`);
    expect(reads.rows).toEqual([{ actor_user_id: fx.coord.userId }]);

    mail.clear();
    const r2 = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, { attachW9ForAll: true, missingW9: "send", includeWaiting: false }, FRIDAY));
    expect(r2.sent).toBe(1);
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].attachments!.some((a) => a.filename.startsWith("W-9"))).toBe(false);
    expect((await row(i2.id)).attachW9).toBe(false);
  });

  test("a coordinator can attach the W-9 when approving a single immediate send, audited as theirs", async () => {
    const { db } = get();
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "all", invoiceSendSchedule: "immediate" }));
    const p = await person("Morgan Approve");
    await db.transaction((tx) => uploadW9(p, tx, W9_PDF, "w9.pdf"));
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    const approved = await db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, BILL, { attachW9: true }));
    expect(approved.status).toBe("sent");
    expect(approved.attachW9).toBe(true);
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].attachments!.map((a) => a.filename)).toContain("W-9 Morgan Approve.pdf");
    const reads = await db.execute(sql`select actor_user_id from audit_log where action = 'w9.read' and after->>'invoiceId' = ${inv.id}`);
    expect(reads.rows).toEqual([{ actor_user_id: fx.coord.userId }]);
    const [approveAudit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, inv.id), eq(auditLog.action, "invoice.approve")));
    expect(approveAudit.before).toMatchObject({ attachW9: false, w9RequestedBy: null });
    expect(approveAudit.after).toMatchObject({ attachW9: true, w9RequestedBy: fx.coord.userId });

    const q = await person("Nico No W9");
    const d2 = await detail([q]);
    const inv2 = await bill(q, d2.rows[0].id, d2.job);
    await expect(db.transaction((tx) => approveInvoice(fx.coord, tx, inv2.id, BILL, { attachW9: true }))).rejects.toBeInstanceOf(RuleViolation);
    expect((await db.transaction((tx) => staffInvoice(fx.coord, tx, inv2.id))).payeeHasW9).toBe(false);
  });

  test("the payee sees when a queued invoice goes out, and the staff view says it is ready to send", async () => {
    const { db } = get();
    const p = await person("Oakley Payee");
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    const [mine] = await db.transaction((tx) => myInvoices(p, tx, WEDNESDAY, inv.id));
    expect(mine.queuedSend).toBe("Queued for the weekly send on Fri, Jan 4.");
    const staff = await db.transaction((tx) => staffInvoice(fx.coord, tx, inv.id, WEDNESDAY));
    expect(staff.status).toBe("ready_to_send");
    expect(staff.queuedSend).toBe("Queued for the weekly send on Fri, Jan 4.");
  });

  test("a queued invoice can still be edited or sent back before it goes", async () => {
    const { db } = get();
    const p = await person("Parker Fix");
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    const edited = await db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { rateCents: 8000, reason: "Holiday rate" }));
    expect(edited.status).toBe("ready_to_send");
    expect(edited.revision).toBe(0);
    await drain();
    expect(mail.sent).toHaveLength(0);
    const back = await db.transaction((tx) => sendBackInvoice(fx.coord, tx, inv.id, "Check the hours"));
    expect(back.status).toBe("returned");
  });

  test("the daily tick alerts coordinators on a send day when batches are due", async () => {
    const { db } = get();
    const p = await person("Quinn Tick");
    const d = await detail([p]);
    await bill(p, d.rows[0].id, d.job);
    const before = await db.select().from(notifications).where(eq(notifications.type, "invoice.batch_due"));
    expect(await invoiceBatchesDueTick(WEDNESDAY)).toBe(0);
    expect(await invoiceBatchesDueTick(FRIDAY)).toBe(1);
    const after = await db.select().from(notifications).where(and(eq(notifications.type, "invoice.batch_due"), eq(notifications.userId, fx.coord.userId)));
    expect(after.length).toBeGreaterThan(before.filter((n) => n.userId === fx.coord.userId).length);
    expect(after.at(-1)?.link).toBe("/coordinate/send-invoices");
  });

  const SEND = { attachW9ForAll: false, missingW9: "send" as const, includeWaiting: false };

  test("a change that commits while a send waits on the invoice's row lock is not overwritten; with nothing left, nothing is sent", async () => {
    const { db } = get();
    const p = await person("Wren Race");
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let backDone!: () => void;
    const backed = new Promise<void>((r) => (backDone = r));
    // Any writer that changes the invoice under its row lock (send back, edit) without touching the vendor row.
    const back = db.transaction(async (tx) => {
      await tx.select().from(invoices).where(eq(invoices.id, inv.id)).for("update");
      await tx.update(invoices).set({ status: "returned", emailStatus: "not_queued" }).where(eq(invoices.id, inv.id));
      backDone();
      await gate;
    });
    await backed;
    const send = db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY));
    await new Promise((r) => setTimeout(r, 400));
    release();
    await back;
    const outcome = await send.then(() => "sent", (e: unknown) => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e)));
    expect(outcome).toMatch(/^ValidationError/);
    const r = await row(inv.id);
    expect(r.status).toBe("returned");
    expect(r.sentAt).toBeNull();
    expect(r.batchId).toBeNull();
    expect(await db.select().from(invoiceEvents).where(and(eq(invoiceEvents.invoiceId, inv.id), eq(invoiceEvents.event, "sent")))).toHaveLength(0);
  });

  test("a second send, and two sends at once, are refused once the batch has gone", async () => {
    const { db } = get();
    const p = await person("Xan Twice");
    const d = await detail([p]);
    await bill(p, d.rows[0].id, d.job);
    const results = await Promise.allSettled([
      db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY)),
      db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY)),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY))).rejects.toThrow("There are no invoices ready to send");
  });

  test("a batch email that finally fails puts its invoices back in the queue, stops the clock and says so on Send invoices", async () => {
    const { db } = get();
    const p = await person("Yael Bounce");
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY));
    setEmailSender({ send: async () => { throw new Error(`554 5.7.1 <ap@vendor.example>: relay rejected, api_key=${FAKE_PROVIDER_KEY}`); } });
    await expect(deliverInvoiceBatchEmail(r.batchId, { finalAttempt: true })).rejects.toThrow("554");
    setEmailSender(mail);
    const back = await row(inv.id);
    expect(back.status).toBe("ready_to_send");
    expect(back.sentAt).toBeNull();
    expect(back.batchId).toBeNull();
    expect(back.responsibleParty).toBeNull();
    expect(back.responsibleSince).toBeNull();
    const [batch] = await db.select().from(invoiceBatches).where(eq(invoiceBatches.id, r.batchId));
    expect(batch.emailStatus).toBe("failed");
    const ev = await db.select().from(invoiceEvents).where(and(eq(invoiceEvents.invoiceId, inv.id), eq(invoiceEvents.event, "send_failed")));
    expect(ev).toHaveLength(1);
    expect(ev[0].vendorVisible).toBe(false);
    const [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.invoices.map((i) => i.id)).toEqual([inv.id]);
    // The provider's own words, with addresses and secrets taken out.
    expect(b.lastSendFailed).toContain("554 5.7.1");
    expect(b.lastSendFailed).toContain("relay rejected");
    expect(b.lastSendFailed).not.toContain("ap@vendor.example");
    expect(b.lastSendFailed).not.toContain(FAKE_PROVIDER_KEY);
    const [alert] = await db.select().from(notifications).where(and(eq(notifications.userId, fx.coord.userId), eq(notifications.type, "invoice.email_failed")));
    expect(alert.link).toBe(`/coordinate/send-invoices#vendor-${fx.vendorId}`);
    // The job left in the queue does nothing more, and the invoice can go again.
    await drain();
    expect(mail.sent).toHaveLength(0);
    const RESEND = agencyInstant(2036, 1, 5, 10, 0);
    await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, RESEND));
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect((await row(inv.id)).status).toBe("sent");
    expect((await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY))).length).toBe(0);
    // The vendor sees one send, dated at the one that reached them; staff keep the failed one, marked superseded.
    const vendorUser = await makeUser(db, "vendor", "bat-vendor-resend@example.test");
    const vendor: Actor = { ...vendorUser.actor, vendorId: fx.vendorId };
    const seen = await db.transaction((tx) => invoiceTimeline(vendor, tx, inv.id));
    const sentSeen = seen.filter((e) => e.event === "sent");
    expect(sentSeen).toHaveLength(1);
    expect(sentSeen[0].at.getTime()).toBe(RESEND.getTime());
    expect(seen.every((e) => e.at.getTime() !== FRIDAY.getTime())).toBe(true);
    const staffSent = await db.select().from(invoiceEvents).where(and(eq(invoiceEvents.invoiceId, inv.id), eq(invoiceEvents.event, "sent")));
    expect(staffSent).toHaveLength(2);
    expect(staffSent.find((e) => e.at.getTime() === FRIDAY.getTime())?.note).toBe("Not delivered: the batch email failed.");
  });

  test("an invoice the vendor marked paid while the email was retrying stays sent when the batch fails", async () => {
    const { db } = get();
    const p = await person("Gale Paid");
    const q = await person("Hal Unpaid");
    const d1 = await detail([p]);
    const d2 = await detail([q]);
    const paid = await bill(p, d1.rows[0].id, d1.job);
    const unpaid = await bill(q, d2.rows[0].id, d2.job);
    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY));
    const vendorUser = await makeUser(db, "vendor", "bat-vendor-paid@example.test");
    const vendor: Actor = { ...vendorUser.actor, vendorId: fx.vendorId };
    const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.active, true)).limit(1);
    await db.transaction((tx) => vendorMarkPaid(vendor, tx, paid.id, { paymentMethodId: method.id, reference: "CHK 1001", paidAt: FRIDAY }, FRIDAY));
    const beforeFail = await row(paid.id);
    setEmailSender({ send: async () => { throw new Error("451 try later"); } });
    await expect(deliverInvoiceBatchEmail(r.batchId, { finalAttempt: true })).rejects.toThrow("451");
    setEmailSender(mail);
    const kept = await row(paid.id);
    expect(kept.status).toBe("sent");
    expect(kept.sentAt?.getTime()).toBe(FRIDAY.getTime());
    expect(kept.batchId).toBe(r.batchId);
    expect(kept.responsibleParty).toBe(beforeFail.responsibleParty);
    expect(kept.responsibleSince?.getTime()).toBe(beforeFail.responsibleSince?.getTime());
    const note = await db.select().from(invoiceEvents).where(and(eq(invoiceEvents.invoiceId, paid.id), eq(invoiceEvents.event, "send_failed_kept")));
    expect(note).toHaveLength(1);
    expect(note[0].vendorVisible).toBe(false);
    expect((await row(unpaid.id)).status).toBe("ready_to_send");
  });

  test("an invoice paid on the spot is still requeued when its batch email fails, and shows on Send invoices", async () => {
    const { db } = get();
    const p = await person("Ivy Spot Paid");
    const d = await detail([p]);
    const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.active, true)).limit(1);
    const inv = (
      await db.transaction((tx) => billAssignment(p, tx, d.rows[0].id, { startAt: d.job.startAt, endAt: d.job.endAt, attachW9: false, paidOnSpot: { methodId: method.id, reference: "Cash" } }, BILL))
    ).invoice;
    // Paid on the spot: closed as paid and queued as its paid version.
    expect(inv).toMatchObject({ status: "paid", paidSendQueued: true });
    expect(inv.deputyPaidAt).not.toBeNull();
    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY));
    setEmailSender({ send: async () => { throw new Error("421 service unavailable"); } });
    await expect(deliverInvoiceBatchEmail(r.batchId, { finalAttempt: true })).rejects.toThrow("421");
    setEmailSender(mail);
    const back = await row(inv.id);
    expect(back.status).toBe("paid");
    expect(back.sentAt).toBeNull();
    const [b] = await db.transaction((tx) => listInvoiceBatches(fx.coord, tx, FRIDAY));
    expect(b.invoices.map((i) => i.id)).toContain(inv.id);
    expect(b.lastSendFailed).toContain("421 service unavailable");
  });

  test("provider errors lose any credential after Authorization, Bearer or Basic, however short", () => {
    const out = redactProviderError("401 bad auth. Authorization: Bearer abc123, retry with Basic dXNlcg== or bearer x1");
    expect(out).toContain("401 bad auth.");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("dXNlcg==");
    expect(out).not.toMatch(/bearer x1/i);
    expect(redactProviderError("authorization=Token t0k")).not.toContain("t0k");
  });

  test("a batch whose every invoice was sent back is not emailed or marked sent, and the send-back clears the batch", async () => {
    const { db } = get();
    const p = await person("Zane Pulled");
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    const r = await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY));
    await db.transaction((tx) => sendBackInvoice(fx.coord, tx, inv.id, "Pulled"));
    expect((await row(inv.id)).batchId).toBeNull();
    await drain();
    expect(mail.sent).toHaveLength(0);
    const [batch] = await db.select().from(invoiceBatches).where(eq(invoiceBatches.id, r.batchId));
    expect(batch.emailStatus).not.toBe("sent");
    expect(await db.select().from(auditLog).where(and(eq(auditLog.entityId, r.batchId), eq(auditLog.action, "invoice_batch.email_sent")))).toHaveLength(0);
  });

  test("a vendor cannot open a queued invoice's timeline until it is sent", async () => {
    const { db } = get();
    const vendorUser = await makeUser(db, "vendor", "bat-vendor@example.test");
    const vendor: Actor = { ...vendorUser.actor, vendorId: fx.vendorId };
    const p = await person("Ari Hidden");
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    await expect(db.transaction((tx) => invoiceTimeline(vendor, tx, inv.id))).rejects.toBeInstanceOf(ForbiddenError);
    await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY));
    const events = await db.transaction((tx) => invoiceTimeline(vendor, tx, inv.id));
    expect(events.map((e) => e.event)).toContain("sent");
    expect(events.map((e) => e.event)).not.toContain("ready_to_send");
  });

  test("a W-9 the payee chose goes with the batch, its read audited as the sending coordinator", async () => {
    const { db } = get();
    const p = await person("Bea Chose W9");
    await db.transaction((tx) => uploadW9(p, tx, W9_PDF, "w9.pdf"));
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job, true);
    await db.transaction((tx) => sendInvoiceBatch(fx.coord, tx, fx.vendorId, SEND, FRIDAY));
    await drain();
    expect(mail.sent[0].attachments!.map((a) => a.filename)).toContain("W-9 Bea Chose W9.pdf");
    const reads = await db.execute(sql`select actor_user_id from audit_log where action = 'w9.read' and after->>'invoiceId' = ${inv.id}`);
    expect(reads.rows).toEqual([{ actor_user_id: fx.coord.userId }]);
  });

  test("once the send day has passed, the payee is told the next real send day", async () => {
    const { db } = get();
    const p = await person("Cy Late");
    const d = await detail([p]);
    const inv = await bill(p, d.rows[0].id, d.job);
    const saturday = agencyInstant(2036, 1, 5, 9, 0);
    const [mine] = await db.transaction((tx) => myInvoices(p, tx, saturday, inv.id));
    expect(mine.queuedSend).toBe("Queued for the weekly send on Fri, Jan 11.");
  });

  test("personnel cannot list or send batches", async () => {
    const { db } = get();
    const p = await person("Riley Personnel");
    await expect(db.transaction((tx) => listInvoiceBatches(p, tx, FRIDAY))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      db.transaction((tx) => sendInvoiceBatch(p, tx, fx.vendorId, { attachW9ForAll: false, missingW9: "send", includeWaiting: false }, FRIDAY)),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });
});
