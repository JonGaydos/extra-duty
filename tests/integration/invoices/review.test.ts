import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture, HOUR } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoiceEvents, invoices, notifications, paymentMethods, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment } from "@/domain/billing/bill";
import { coordinatorCloseInvoice, invoiceTimeline, markPaid, vendorMarkPaid } from "@/domain/billing/payments";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { buildInvoicePdfData } from "@/domain/invoices/invoices";
import { approveInvoice, editInvoice, listInvoicesForReview, sendBackInvoice } from "@/domain/invoices/review";
import { updateSettings } from "@/domain/settings/settings";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
const AFTER = new Date("2036-01-01T00:00:00Z");

describe("invoice review", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-review-"));
    fx = await setupFixture(db, "rev");
    admin = (await makeUser(db, "admin", "rev-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(eq(vendors.id, fx.vendorId));
  });

  beforeEach(async () => {
    mail.clear();
    setEmailSender(mail);
    await get().db.transaction((tx) =>
      updateSettings(admin, tx, {
        email: GOOD_EMAIL,
        billingReplyToEmail: "billing@sheriff.example",
        invoiceReviewMode: "all",
        minimumBillableMinutes: 240,
        hourRoundingMinutes: 15,
      }),
    );
    await drain();
    mail.clear();
  });

  /** A held (pending_review) invoice for a job 17:00 to 23:00 billed as worked. */
  async function held(over: { mode?: "all" | "immediate" } = {}) {
    const { db } = get();
    if (over.mode) await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: over.mode }));
    const person = await fx.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, person.userId));
    const { job, positionId } = await fx.mkJob();
    const [a] = await db
      .insert(assignments)
      .values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "signed_up" })
      .returning();
    const r = await db.transaction((tx) =>
      billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, AFTER),
    );
    return { a, job, person, inv: r.invoice };
  }
  const row = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0];
  const audits = async (id: string, action: string) =>
    get().db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, action)));

  test("a held invoice has emailStatus not_queued", async () => {
    const { inv } = await held();
    expect(inv.status).toBe("pending_review");
    expect(inv.emailStatus).toBe("not_queued");
  });

  test("personnel cannot approve, edit, send back or list", async () => {
    const { inv, person } = await held();
    await expect(get().db.transaction((tx) => approveInvoice(person, tx, inv.id))).rejects.toThrow(ForbiddenError);
    await expect(get().db.transaction((tx) => editInvoice(person, tx, inv.id, { reason: "x" }))).rejects.toThrow(ForbiddenError);
    await expect(get().db.transaction((tx) => sendBackInvoice(person, tx, inv.id))).rejects.toThrow(ForbiddenError);
    await expect(get().db.transaction((tx) => listInvoicesForReview(person, tx))).rejects.toThrow(ForbiddenError);
  });

  test("approve sends the invoice, queues the email and audits", async () => {
    const { inv } = await held();
    const now = new Date("2036-01-02T00:00:00Z");
    const out = await get().db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id, now));
    expect(out.status).toBe("sent");
    expect(out.sentAt).toEqual(now);
    expect(out.responsibleParty).toBe("vendor");
    expect(out.emailStatus).toBe("queued");
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).not.toContain("Revised");
    expect((await row(inv.id)).emailStatus).toBe("sent");
    expect(await audits(inv.id, "invoice.approve")).toHaveLength(1);
    await expect(get().db.transaction((tx) => approveInvoice(fx.coord, tx, inv.id))).rejects.toThrow(RuleViolation);
  });

  test("edit without a reason throws", async () => {
    const { inv } = await held();
    await expect(get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { rateCents: 8000, reason: "  " }))).rejects.toThrow(
      new ValidationError("Give a reason for the change"),
    );
  });

  test("editing a pending invoice recomputes it, keeps it pending and updates the assignment times", async () => {
    const { inv, a, job } = await held();
    const endAt = new Date(job.endAt.getTime() + HOUR);
    const out = await get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { endAt, rateCents: 8000, reason: "Ran long" }));
    expect(out.status).toBe("pending_review");
    expect(out.revision).toBe(0);
    expect(out.minutes).toBe(420);
    expect(out.rateCents).toBe(8000);
    expect(out.totalCents).toBe(56000);
    expect(out.emailStatus).toBe("not_queued");
    const [asg] = await get().db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(asg.actualEndAt).toEqual(endAt);
    expect(asg.actualStartAt).toEqual(job.startAt);
    expect(asg.hoursChangeReason).toBeNull();
    const events = await get().db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, inv.id));
    expect(events.filter((e) => e.event !== "responsibility").map((e) => [e.event, e.note])).toEqual([["edited", "Ran long"]]);
    await drain();
    expect(mail.sent).toHaveLength(0);
    const [audit] = await audits(inv.id, "invoice.edit");
    expect(audit.reason).toBe("Ran long");
  });

  test("a rate-only edit keeps the billed minutes even after the agency minimum changed", async () => {
    const { inv } = await held();
    expect(inv.minutes).toBe(360);
    await get().db.transaction((tx) => updateSettings(admin, tx, { minimumBillableMinutes: 480 }));
    const out = await get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { rateCents: 8000, reason: "Agreed rate" }));
    expect(out.minutes).toBe(360);
    expect(out.totalCents).toBe(48000);
    // The same rate again is a no-op, whatever the current minimum would give.
    await expect(get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { rateCents: 8000, reason: "Again" }))).rejects.toThrow("Nothing changed");
  });

  test("a per-invoice minimum wins and shows on the PDF data", async () => {
    const { inv, job } = await held();
    const out = await get().db.transaction((tx) =>
      editInvoice(fx.coord, tx, inv.id, {
        endAt: new Date(job.startAt.getTime() + HOUR),
        minimumBillableMinutes: 120,
        reason: "Short detail, 2 hour minimum agreed",
      }),
    );
    expect(out.minutes).toBe(120);
    expect(out.minimumOverrideMinutes).toBe(120);
    const data = await get().db.transaction((tx) => buildInvoicePdfData(tx, inv.id));
    expect(data.minimumMinutes).toBe(120);
  });

  test("editing a sent invoice sets revision 1 and queues a Revised email", async () => {
    const { inv, job } = await held({ mode: "immediate" });
    expect(inv.status).toBe("sent");
    await drain();
    mail.clear();
    const out = await get().db.transaction((tx) =>
      editInvoice(fx.coord, tx, inv.id, { endAt: new Date(job.endAt.getTime() + HOUR), reason: "Ran long" }),
    );
    expect(out.status).toBe("sent");
    expect(out.revision).toBe(1);
    expect(out.minutes).toBe(420);
    expect(out.emailStatus).toBe("queued");
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].subject).toContain("Revised");
    expect((await row(inv.id)).emailStatus).toBe("sent");
  });

  test("a deputy's change reason stays on the assignment after a coordinator edit", async () => {
    await get().db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "changed_hours_only" }));
    const { db } = get();
    const person = await fx.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, person.userId));
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "signed_up" }).returning();
    const r = await db.transaction((tx) =>
      billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: new Date(job.endAt.getTime() + HOUR), changeReason: "Deputy reason", attachW9: false }, AFTER),
    );
    await db.transaction((tx) => editInvoice(fx.coord, tx, r.invoice.id, { rateCents: 9000, reason: "Coordinator reason" }));
    const [asg] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(asg.hoursChangeReason).toBe("Deputy reason");
    const list = await db.transaction((tx) => listInvoicesForReview(fx.coord, tx));
    expect(list.find((x) => x.id === r.invoice.id)?.changeReason).toBe("Deputy reason");
  });

  test("a no-op edit throws and does not bump the revision or re-send", async () => {
    const { inv, job } = await held({ mode: "immediate" });
    await drain();
    mail.clear();
    const same = { startAt: job.startAt, endAt: job.endAt, rateCents: inv.rateCents, reason: "Looked again" };
    await expect(get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, same))).rejects.toThrow(new ValidationError("Nothing changed"));
    await expect(get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { reason: "Nothing" }))).rejects.toThrow("Nothing changed");
    await drain();
    expect(mail.sent).toHaveLength(0);
    expect((await row(inv.id)).revision).toBe(0);
  });

  test("a late cancellation sent back returns to late_canceled and re-bills as a late cancel with the same number", async () => {
    const { db } = get();
    const person = await fx.person();
    await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, person.userId));
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "late_canceled" }).returning();
    const input = { startAt: job.startAt, endAt: job.endAt, attachW9: false };
    const first = await db.transaction((tx) => billAssignment(person, tx, a.id, input, AFTER));
    expect(first.invoice.kind).toBe("late_cancel");
    await db.transaction((tx) => sendBackInvoice(fx.coord, tx, first.invoice.id, "Please re-check"));
    const [back] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(back.status).toBe("late_canceled");
    expect(back.billedAt).toBeNull();
    const again = await db.transaction((tx) => billAssignment(person, tx, a.id, input, AFTER));
    expect(again.invoice.id).toBe(first.invoice.id);
    expect(again.invoice.number).toBe(first.invoice.number);
    expect(again.invoice.kind).toBe("late_cancel");
    expect(again.invoice.minutes).toBe(first.invoice.minutes);
  });

  test("an email queued before the invoice was sent back is not sent", async () => {
    const { inv } = await held({ mode: "immediate" });
    await get().db.transaction((tx) => sendBackInvoice(fx.coord, tx, inv.id));
    await drain();
    expect(mail.sent).toHaveLength(0);
    expect((await row(inv.id)).emailStatus).toBe("not_queued");
  });

  test("a re-bill clears the per-invoice minimum", async () => {
    const { inv, a, job, person } = await held();
    await get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { minimumBillableMinutes: 60, endAt: new Date(job.startAt.getTime() + HOUR), reason: "Short" }));
    await get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { minimumBillableMinutes: 90, reason: "Raise" }));
    expect((await row(inv.id)).minimumOverrideMinutes).toBe(90);
    await get().db.transaction((tx) => sendBackInvoice(fx.coord, tx, inv.id));
    const r = await get().db.transaction((tx) =>
      billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, AFTER),
    );
    expect(r.invoice.minimumOverrideMinutes).toBeNull();
    expect(r.invoice.minutes).toBe(360);
  });

  test("paid, written off and returned invoices cannot be edited", async () => {
    for (const status of ["paid", "written_off", "returned"] as const) {
      const { inv } = await held();
      await get().db.update(invoices).set({ status }).where(eq(invoices.id, inv.id));
      await expect(get().db.transaction((tx) => editInvoice(fx.coord, tx, inv.id, { rateCents: 1, reason: "x" }))).rejects.toThrow(RuleViolation);
    }
  });

  test("send back alerts the person, resets the assignment and the re-bill reuses the number", async () => {
    const { inv, a, job, person } = await held();
    const out = await get().db.transaction((tx) => sendBackInvoice(fx.coord, tx, inv.id, "Check your end time"));
    expect(out.status).toBe("returned");
    expect(out.responsibleParty).toBe("deputy");
    expect(out.emailStatus).toBe("not_queued");
    const [asg] = await get().db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(asg.status).toBe("signed_up");
    expect(asg.actualStartAt).toBeNull();
    expect(asg.actualEndAt).toBeNull();
    expect(asg.billedAt).toBeNull();
    const [n] = await get().db.select().from(notifications).where(and(eq(notifications.userId, person.userId), eq(notifications.type, "invoice.returned")));
    expect(n.body).toBe("Check your end time");
    expect(await audits(inv.id, "invoice.send_back")).toHaveLength(1);

    const r = await get().db.transaction((tx) =>
      billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: new Date(job.endAt.getTime() - HOUR), changeReason: "Left early", attachW9: false }, AFTER),
    );
    expect(r.invoice.id).toBe(inv.id);
    expect(r.invoice.number).toBe(inv.number);
    expect(r.invoice.status).toBe("pending_review");
    expect(r.invoice.revision).toBe(0);
    expect(r.invoice.minutes).toBe(300);
    expect(await audits(inv.id, "invoice.rebill")).toHaveLength(1);
    const all = await get().db.select().from(invoices).where(eq(invoices.assignmentId, a.id));
    expect(all).toHaveLength(1);
  });

  test("sending back a sent invoice then re-billing increments the revision", async () => {
    const { inv, a, job, person } = await held({ mode: "immediate" });
    await get().db.transaction((tx) => sendBackInvoice(fx.coord, tx, inv.id));
    const r = await get().db.transaction((tx) =>
      billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, AFTER),
    );
    expect(r.invoice.number).toBe(inv.number);
    expect(r.invoice.status).toBe("sent");
    expect(r.invoice.revision).toBe(1);
    expect(r.invoice.emailStatus).toBe("queued");
  });

  test("only pending or sent invoices can be sent back", async () => {
    const { inv } = await held();
    await get().db.update(invoices).set({ status: "paid" }).where(eq(invoices.id, inv.id));
    await expect(get().db.transaction((tx) => sendBackInvoice(fx.coord, tx, inv.id))).rejects.toThrow(RuleViolation);
  });

  test("the review list holds pending invoices, oldest first, with details", async () => {
    const { db } = get();
    await db.update(invoices).set({ status: "paid" }).where(eq(invoices.status, "pending_review"));
    const first = await held();
    const second = await held();
    await db.update(invoices).set({ createdAt: new Date("2020-01-01T00:00:00Z") }).where(eq(invoices.id, second.inv.id));
    await held({ mode: "immediate" });
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "all" }));
    const list = await db.transaction((tx) => listInvoicesForReview(fx.coord, tx));
    expect(list.map((r) => r.id)).toEqual([second.inv.id, first.inv.id]);
    expect(list[0]).toMatchObject({ vendorName: "rev Vendor", jobTitle: "Stadium security", minutes: 360, workedMinutes: 360, totalCents: 42000 });
    expect(list[0].jobNumber).toBe(second.job.number);
  });

  test("a vendor sees only allowlisted events across the whole lifecycle, never coordinator reasons or comments", async () => {
    const { db } = get();
    const vendor: Actor = { ...(await makeUser(db, "vendor", "rev-vendor@example.test")).actor, vendorId: fx.vendorId };
    const [{ id: methodId }] = await db.select({ id: paymentMethods.id }).from(paymentMethods).limit(1);
    const tx = <T,>(fn: (t: Parameters<Parameters<typeof db.transaction>[0]>[0]) => Promise<T>) => db.transaction(fn);
    const pay = { paymentMethodId: methodId, reference: "1", paidAt: new Date("2035-12-01T00:00:00Z") };
    const NOTES = ["Secret edit reason", "Secret send back comment", "Secret close reason", "Left early"];

    const { inv, a, job, person } = await held();
    await tx((t) => editInvoice(fx.coord, t, inv.id, { rateCents: 8000, reason: NOTES[0] }));
    await tx((t) => approveInvoice(fx.coord, t, inv.id, AFTER));
    await tx((t) => editInvoice(fx.coord, t, inv.id, { rateCents: 8500, reason: NOTES[0] }));
    await tx((t) => sendBackInvoice(fx.coord, t, inv.id, NOTES[1], AFTER));
    await tx((t) => billAssignment(person, t, a.id, { startAt: job.startAt, endAt: new Date(job.endAt.getTime() - HOUR), changeReason: NOTES[3], attachW9: false }, AFTER));
    await tx((t) => approveInvoice(fx.coord, t, inv.id, AFTER));
    await tx((t) => vendorMarkPaid(vendor, t, inv.id, { ...pay, note: "Mailed check" }, AFTER));
    await tx((t) => markPaid(person, t, inv.id, { ...pay, note: "Got it" }, AFTER));

    const staff = await tx((t) => invoiceTimeline(fx.coord, t, inv.id));
    expect(staff.map((e) => e.event).sort()).toEqual(
      ["edited", "edited", "rebilled", "returned", "revised", "sent", "sent", "vendor_paid", "deputy_paid"].concat(Array(7).fill("responsibility")).sort(),
    );
    expect(staff.find((e) => e.event === "returned")?.note).toBe(NOTES[1]);
    expect(staff.find((e) => e.event === "returned")?.vendorVisible).toBe(false);

    const seen = await tx((t) => invoiceTimeline(vendor, t, inv.id));
    // Responsibility is shown only for the vendor's turn, or the payee's turn once the invoice is sent; never review holds or send backs.
    expect(seen.map((e) => (e.event === "responsibility" ? `responsibility:${e.party}` : e.event)).sort()).toEqual(
      ["revised", "sent", "sent", "vendor_paid", "deputy_paid", "responsibility:vendor", "responsibility:vendor", "responsibility:deputy"].sort(),
    );
    for (const e of seen) expect(Object.keys(e).sort()).toEqual(["at", "event", "id", "invoiceId", "note", "party"]);
    expect(seen.map((e) => e.note).filter(Boolean).sort()).toEqual(["Got it", "Mailed check"]);
    for (const n of NOTES) expect(JSON.stringify(seen)).not.toContain(n);
    // Staff rows name who acted.
    expect(staff.filter((e) => e.event === "responsibility").every((e) => e.actorUserId !== null)).toBe(true);

    // Closure: the vendor sees the outcome but not the reason.
    const b = await held({ mode: "immediate" });
    await tx((t) => coordinatorCloseInvoice(fx.coord, t, b.inv.id, { outcome: "written_off", reason: NOTES[2] }));
    const closed = await tx((t) => invoiceTimeline(vendor, t, b.inv.id));
    const outcome = closed.find((e) => e.event === "closed_written_off");
    expect(outcome).toBeTruthy();
    expect(outcome?.note).toBeNull();
    expect(JSON.stringify(closed)).not.toContain(NOTES[2]);
    const forStaff = await tx((t) => invoiceTimeline(fx.coord, t, b.inv.id));
    expect(forStaff.find((e) => e.event === "closed_written_off")?.note).toBe(NOTES[2]);
  });
});
