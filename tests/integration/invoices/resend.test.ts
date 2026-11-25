import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoiceEvents, invoices, users, vendors, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment } from "@/domain/billing/bill";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { approveInvoice, resendInvoice } from "@/domain/invoices/review";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { uploadW9 } from "@/domain/w9/w9";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
const BILL = agencyInstant(2035, 12, 31, 9, 0);
const LATER = agencyInstant(2036, 1, 20, 9, 0);
const W9_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("w9 form body ".repeat(20))]);

describe("resend an invoice", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let vendorActor: Actor;

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "rsd");
    admin = (await makeUser(db, "admin", "rsd-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example", "books@vendor.example"] }).where(inArray(vendors.id, [fx.vendorId, fx.otherVendorId]));
    const v = await makeUser(db, "vendor", "rsd-vendor@example.test");
    await db.insert(vendorUsers).values({ userId: v.row.id, vendorId: fx.vendorId });
    vendorActor = { ...v.actor, vendorId: fx.vendorId };
  });

  beforeEach(async () => {
    mail.clear();
    setEmailSender(mail);
    await get().db.transaction((tx) => updateSettings(admin, tx, { email: GOOD_EMAIL, billingReplyToEmail: "billing@sheriff.example", invoiceReviewMode: "all", invoiceSendSchedule: "immediate" }));
    await drain();
    mail.clear();
  });

  async function held() {
    const { db } = get();
    const p = await fx.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
    return (await db.transaction((tx) => billAssignment(p, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, BILL))).invoice;
  }
  const row = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0];

  test("goes to the billing emails plus one extra address, keeps the revision, starts no clock and is audited", async () => {
    const { db } = get();
    const inv = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, BILL, { send: true }));
    await drain();
    mail.clear();
    const before = await row(inv.id);
    const eventsBefore = (await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, inv.id))).length;
    const r = await db.transaction((tx) => resendInvoice(fx.coord, tx, inv.id, { alsoTo: " Owner@Vendor.example " }, LATER));
    expect(r.to).toEqual(["ap@vendor.example", "books@vendor.example", "owner@vendor.example"]);
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual(["ap@vendor.example", "books@vendor.example", "owner@vendor.example"]);
    expect(mail.sent[0].attachments!.some((a) => a.filename.endsWith(".pdf"))).toBe(true);
    const after = await row(inv.id);
    expect(after).toMatchObject({ revision: before.revision, status: "sent", responsibleParty: before.responsibleParty, emailStatus: "sent" });
    expect(after.responsibleSince?.getTime()).toBe(before.responsibleSince?.getTime());
    expect(after.sentAt?.getTime()).toBe(before.sentAt?.getTime());
    const events = await db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, inv.id));
    const fresh = events.slice(eventsBefore);
    expect(fresh.map((e) => e.event)).toEqual(["resent"]);
    expect(fresh[0].vendorVisible).toBe(false);
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, inv.id), eq(auditLog.action, "invoice.resend")));
    expect(audit.after).toMatchObject({ to: ["ap@vendor.example", "books@vendor.example", "owner@vendor.example"] });
    // The extra address is not saved to the vendor.
    expect((await db.select().from(vendors).where(eq(vendors.id, fx.vendorId)))[0].billingEmails).toEqual(["ap@vendor.example", "books@vendor.example"]);
  });

  test("a paid invoice resends its paid version; a bad extra address is refused", async () => {
    const { db } = get();
    const inv = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, BILL, { send: true }));
    await db.update(invoices).set({ status: "paid", deputyPaidAt: BILL, responsibleParty: null }).where(eq(invoices.id, inv.id));
    await drain();
    mail.clear();
    await expect(db.transaction((tx) => resendInvoice(admin, tx, inv.id, { alsoTo: "not an email" }, LATER))).rejects.toThrow(ValidationError);
    await db.transaction((tx) => resendInvoice(admin, tx, inv.id, {}, LATER));
    await drain();
    expect(mail.sent.map((m) => m.to)).toEqual([["ap@vendor.example", "books@vendor.example"]]);
    expect((await row(inv.id)).status).toBe("paid");
  });

  test("is refused for an invoice never sent", async () => {
    const { db } = get();
    const inv = await held();
    await expect(db.transaction((tx) => resendInvoice(fx.coord, tx, inv.id, {}, LATER))).rejects.toThrow(RuleViolation);
    await db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, BILL, { send: false }));
    await expect(db.transaction((tx) => resendInvoice(fx.coord, tx, inv.id, {}, LATER))).rejects.toThrow(RuleViolation);
  });

  test("personnel and vendors are forbidden", async () => {
    const { db } = get();
    const inv = await held();
    await db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, BILL, { send: true }));
    const deputy = await fx.person();
    await expect(db.transaction((tx) => resendInvoice(deputy, tx, inv.id, {}, LATER))).rejects.toThrow(ForbiddenError);
    await expect(db.transaction((tx) => resendInvoice(vendorActor, tx, inv.id, {}, LATER))).rejects.toThrow(ForbiddenError);
  });

  test("with an extra address the W-9 goes only to the billing emails, and its read is audited as the coordinator resending", async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-resend-"));
    const p = await fx.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    await db.transaction((tx) => uploadW9(p, tx, W9_PDF, "w9.pdf"));
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" }).returning();
    const inv = (await db.transaction((tx) => billAssignment(p, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: true }, BILL))).invoice;
    await db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, BILL, { send: true }));
    await drain();
    mail.clear();
    const since = new Date();
    await db.transaction((tx) => resendInvoice(admin, tx, inv.id, { alsoTo: "owner@vendor.example" }, LATER));
    await drain();
    const byTo = Object.fromEntries(mail.sent.map((m) => [m.to.join(","), m.attachments!.map((x) => x.filename)]));
    expect(Object.keys(byTo).sort()).toEqual(["ap@vendor.example,books@vendor.example", "owner@vendor.example"]);
    expect(byTo["ap@vendor.example,books@vendor.example"].some((f) => f.startsWith("W-9"))).toBe(true);
    expect(byTo["owner@vendor.example"].some((f) => f.startsWith("W-9"))).toBe(false);
    const reads = (await db.select().from(auditLog).where(eq(auditLog.action, "w9.read"))).filter((r) => r.at >= since);
    expect(reads.map((r) => r.actorUserId)).toEqual([admin.userId]);
  });
});
