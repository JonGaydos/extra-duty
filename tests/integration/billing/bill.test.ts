import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture, HOUR } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoices, jobs, paymentMethods, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment, type BillInput } from "@/domain/billing/bill";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { updateSettings } from "@/domain/settings/settings";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";
import { uploadW9 } from "@/domain/w9/w9";
import { approveCurrentW9 } from "../w9/helpers";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

const W9_PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("w9 form body ".repeat(20))]);
const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };

describe("billing a detail", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-bill-"));
    setEmailSender(createMemorySender());
    fx = await setupFixture(db, "bill");
    admin = (await makeUser(db, "admin", "bill-admin@example.test")).actor;
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(eq(vendors.id, fx.vendorId));
  });

  const setSettings = (patch: Parameters<typeof updateSettings>[2]) =>
    get().db.transaction((tx) => updateSettings(admin, tx, patch));

  beforeEach(async () => {
    await setSettings({
      email: GOOD_EMAIL,
      billingReplyToEmail: "billing@sheriff.example",
      invoiceReviewMode: "immediate",
      minimumBillableMinutes: 240,
      hourRoundingMinutes: 15,
      lateCancelPayBasis: "minimum",
    });
  });

  // The job runs 17:00 to 23:00 agency time on a 2035 date; `after` is any later instant.
  const AFTER = new Date("2036-01-01T00:00:00Z");

  async function mk(o: { status?: "signed_up" | "late_canceled"; hours?: [number, number]; address?: string | null } = {}) {
    const { db } = get();
    const person = await fx.person("Deputy Sheriff", { w9: false });
    await db.update(users).set({ mailingAddress: o.address === undefined ? "1 Main St, Town, TX 75001" : o.address }).where(eq(users.id, person.userId));
    const { job, positionId } = await fx.mkJob({ hours: o.hours });
    const [a] = await db
      .insert(assignments)
      .values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: o.status ?? "signed_up" })
      .returning();
    return { a, job, person };
  }

  const input = (job: { startAt: Date; endAt: Date }, over: Partial<BillInput> = {}): BillInput => ({
    startAt: job.startAt,
    endAt: job.endAt,
    attachW9: false,
    ...over,
  });
  const bill = (actor: Actor, id: string, i: BillInput, now = AFTER) =>
    get().db.transaction((tx) => billAssignment(actor, tx, id, i, now));
  const invoiceCount = async (assignmentId: string) =>
    (await get().db.select().from(invoices).where(eq(invoices.assignmentId, assignmentId))).length;

  test("billing before the job ends throws", async () => {
    const { a, job, person } = await mk();
    await expect(bill(person, a.id, input(job), new Date(job.endAt.getTime() - HOUR))).rejects.toThrow(RuleViolation);
    expect(await invoiceCount(a.id)).toBe(0);
  });

  test("changed hours without a reason throws, with a reason it is held in changed_hours_only mode", async () => {
    await setSettings({ invoiceReviewMode: "changed_hours_only" });
    const { a, job, person } = await mk();
    const changed = input(job, { endAt: new Date(job.endAt.getTime() + HOUR) });
    await expect(bill(person, a.id, changed)).rejects.toThrow(ValidationError);
    const r = await bill(person, a.id, { ...changed, changeReason: "Ran long" });
    expect(r.delivery).toBe("held_for_review");
    expect(r.invoice.status).toBe("pending_review");
    expect(r.invoice.sentAt).toBeNull();
    expect(r.invoice.responsibleParty).toBe("coordinator");
    expect(r.invoice.minutes).toBe(420);
    const [row] = await get().db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row.hoursChangeReason).toBe("Ran long");
  });

  test("unchanged hours in changed_hours_only mode are sent and queued", async () => {
    await setSettings({ invoiceReviewMode: "changed_hours_only" });
    const { a, job, person } = await mk();
    const r = await bill(person, a.id, input(job));
    expect(r.delivery).toBe("sent_queued");
    expect(r.invoice.status).toBe("sent");
    expect(r.invoice.sentAt).toEqual(AFTER);
    expect(r.invoice.emailStatus).toBe("queued");
    expect(r.invoice.responsibleParty).toBe("vendor");
    expect(r.invoice.minutes).toBe(360);
    expect(r.invoice.rateCents).toBe(job.rateCents);
  });

  test("planned times are the baseline for changed hours", async () => {
    await setSettings({ invoiceReviewMode: "changed_hours_only" });
    const { a, job, person } = await mk();
    const plannedEnd = new Date(job.endAt.getTime() - HOUR);
    await get().db.update(assignments).set({ plannedStartAt: job.startAt, plannedEndAt: plannedEnd }).where(eq(assignments.id, a.id));
    await expect(bill(person, a.id, input(job))).rejects.toThrow("A reason is required");
    const r = await bill(person, a.id, input(job, { changeReason: "Worked to the job end" }));
    expect(r.delivery).toBe("held_for_review");
  });

  test("end before start throws", async () => {
    const { a, job, person } = await mk();
    await expect(bill(person, a.id, input(job, { endAt: job.startAt }))).rejects.toThrow(new ValidationError("End must be after start"));
    await expect(bill(person, a.id, input(job, { endAt: new Date(job.startAt.getTime() - HOUR) }))).rejects.toThrow("End must be after start");
  });

  test("an 8 PM to 6 AM span across midnight bills 600 minutes", async () => {
    await setSettings({ invoiceReviewMode: "all" });
    const { a, job, person } = await mk({ hours: [20, 23] });
    const start = agencyInstant(2035, 3, 1, 20, 0);
    const end = agencyInstant(2035, 3, 2, 6, 0);
    const r = await bill(person, a.id, input(job, { startAt: start, endAt: end, changeReason: "Overnight" }));
    expect(r.invoice.minutes).toBe(600);
  });

  test("the minimum applies: job, then vendor, then agency", async () => {
    const { db } = get();
    const short = (job: { startAt: Date }) => ({ startAt: job.startAt, endAt: new Date(job.startAt.getTime() + HOUR) });
    await setSettings({ invoiceReviewMode: "all" });
    const one = await mk();
    const r1 = await bill(one.person, one.a.id, input(one.job, { ...short(one.job), changeReason: "Short" }));
    expect(r1.invoice.minutes).toBe(240);
    const two = await mk();
    await db.update(jobs).set({ minimumBillableMinutes: 120 }).where(eq(jobs.id, two.job.id));
    const r2 = await bill(two.person, two.a.id, input(two.job, { ...short(two.job), changeReason: "Short" }));
    expect(r2.invoice.minutes).toBe(120);
    const three = await mk();
    await db.update(vendors).set({ minimumBillableMinutes: 180 }).where(eq(vendors.id, fx.vendorId));
    const r3 = await bill(three.person, three.a.id, input(three.job, { ...short(three.job), changeReason: "Short" }));
    expect(r3.invoice.minutes).toBe(180);
    await db.update(vendors).set({ minimumBillableMinutes: null }).where(eq(vendors.id, fx.vendorId));
  });

  test("attachW9 without a W-9 throws and creates no invoice; with one it is stored", async () => {
    const { a, job, person } = await mk();
    await expect(bill(person, a.id, input(job, { attachW9: true }))).rejects.toThrow(RuleViolation);
    await expect(bill(person, a.id, input(job, { attachW9: true }))).rejects.toThrow("Your W-9 must be approved before it can be attached");
    // An upload alone is not enough: it waits for review.
    await get().db.transaction((tx) => uploadW9(person, tx, W9_PDF, "w9.pdf"));
    await expect(bill(person, a.id, input(job, { attachW9: true }))).rejects.toThrow("approved");
    expect(await invoiceCount(a.id)).toBe(0);
    await approveCurrentW9(get().db, person.userId);
    const r = await bill(person, a.id, input(job, { attachW9: true }));
    expect(r.invoice.attachW9).toBe(true);
  });

  test("a payee with no mailing address throws and creates no invoice", async () => {
    const { a, job, person } = await mk({ address: null });
    const err = await bill(person, a.id, input(job)).catch((e) => e);
    expect(err).toBeInstanceOf(RuleViolation);
    expect(err.message).toBe("Add your mailing address in Profile before billing");
    expect(await invoiceCount(a.id)).toBe(0);
  });

  test("paid on spot stores the method and reference, is sent as a paid invoice and closes as paid, with nobody's turn", async () => {
    const { db } = get();
    const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.name, "Cash"));
    const { a, job, person } = await mk();
    const r = await bill(person, a.id, input(job, { paidOnSpot: { methodId: method.id, reference: "receipt 12" } }));
    expect(r.invoice.status).toBe("paid");
    expect(r.invoice.sentAt).toEqual(AFTER);
    expect(r.invoice.emailStatus).toBe("queued");
    expect(r.invoice.deputyMethodId).toBe(method.id);
    expect(r.invoice.deputyReference).toBe("receipt 12");
    expect(r.invoice.deputyPaidAt).toEqual(AFTER);
    expect(r.invoice.responsibleParty).toBeNull();
    expect(r.delivery).toBe("sent_queued");
    const [asg] = await db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(asg.status).toBe("paid");
  });

  test("paid on spot follows the review decision", async () => {
    await setSettings({ invoiceReviewMode: "all" });
    const [method] = await get().db.select().from(paymentMethods).where(eq(paymentMethods.name, "Cash"));
    const { a, job, person } = await mk();
    const r = await bill(person, a.id, input(job, { paidOnSpot: { methodId: method.id } }));
    expect(r.delivery).toBe("held_for_review");
    expect(r.invoice.status).toBe("pending_review");
    expect(r.invoice.deputyMethodId).toBe(method.id);
  });

  test("an unknown or inactive payment method throws", async () => {
    const { db } = get();
    const [method] = await db.select().from(paymentMethods).where(eq(paymentMethods.name, "Other"));
    const { a, job, person } = await mk();
    await expect(bill(person, a.id, input(job, { paidOnSpot: { methodId: "nope" } }))).rejects.toThrow(ValidationError);
    await db.update(paymentMethods).set({ active: false }).where(eq(paymentMethods.id, method.id));
    await expect(bill(person, a.id, input(job, { paidOnSpot: { methodId: method.id } }))).rejects.toThrow(ValidationError);
    await db.update(paymentMethods).set({ active: true }).where(eq(paymentMethods.id, method.id));
    expect(await invoiceCount(a.id)).toBe(0);
  });

  test("the assignment becomes billed with actual times, and billing twice throws", async () => {
    const { a, job, person } = await mk();
    await bill(person, a.id, input(job));
    const [row] = await get().db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row.status).toBe("billed");
    expect(row.actualStartAt).toEqual(job.startAt);
    expect(row.actualEndAt).toEqual(job.endAt);
    expect(row.billedAt).toEqual(AFTER);
    const err = await bill(person, a.id, input(job)).catch((e) => e);
    expect(err).toBeInstanceOf(RuleViolation);
    expect(err.message).toBe("This detail is already billed");
  });

  test("late-cancel pay cannot be billed before the detail's scheduled end, named in agency time; after it, it bills at the minimum with the job's times", async () => {
    const { a, job, person } = await mk({ status: "late_canceled" });
    const d = agencyDateParts(job.endAt);
    const month = new Intl.DateTimeFormat("en-US", { month: "short", timeZone: "UTC" }).format(new Date(Date.UTC(d.year, d.month - 1, 15)));
    // The job ends at 23:00 agency time, which is the next day in UTC.
    expect(job.endAt.getUTCDate()).not.toBe(d.day);
    for (const early of [new Date(job.startAt.getTime() - 24 * HOUR), new Date(job.endAt.getTime() - 60_000)]) {
      const err = await bill(person, a.id, input(job), early).then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(RuleViolation);
      expect((err as RuleViolation).checks.map((c) => c.message)).toEqual([`You can bill late-cancel pay after ${month} ${d.day}, ${d.year} at 11:00 PM`]);
    }
    expect(await invoiceCount(a.id)).toBe(0);
    const r = await bill(person, a.id, input(job, { startAt: new Date(0), endAt: new Date(1000) }), job.endAt);
    expect(r.invoice.kind).toBe("late_cancel");
    expect(r.invoice.minutes).toBe(240);
    const [row] = await get().db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row.actualStartAt).toEqual(job.startAt);
    expect(row.actualEndAt).toEqual(job.endAt);
  });

  test("late cancel on the scheduled basis bills the job's duration", async () => {
    await setSettings({ lateCancelPayBasis: "scheduled" });
    const { a, job, person } = await mk({ status: "late_canceled" });
    const r = await bill(person, a.id, input(job));
    expect(r.invoice.minutes).toBe(360);
  });

  test("only the assignee or a coordinator or admin bills; vendors and other deputies never", async () => {
    const { db } = get();
    const { a, job, person } = await mk();
    const other = await fx.person();
    await expect(bill(other, a.id, input(job))).rejects.toThrow(ForbiddenError);
    const vendorActor = {
      ...(await makeUser(db, "vendor", "bill-vendor@example.test")).actor,
      vendorId: fx.vendorId,
    };
    await expect(bill(vendorActor, a.id, input(job))).rejects.toThrow(ForbiddenError);
    const r = await bill(fx.coord, a.id, input(job));
    expect(r.invoice.payeeUserId).toBe(person.userId);
  });

  test("only signed_up or late_canceled can be billed", async () => {
    const { a, job, person } = await mk();
    await get().db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, a.id));
    await expect(bill(person, a.id, input(job))).rejects.toThrow(RuleViolation);
  });

  test("a written-off detail and a worked detail on a canceled job are refused with their own checks", async () => {
    const { db } = get();
    const off = await mk();
    await db.update(assignments).set({ writtenOffAt: AFTER }).where(eq(assignments.id, off.a.id));
    const e1 = await bill(off.person, off.a.id, input(off.job)).catch((e) => e);
    expect(e1).toBeInstanceOf(RuleViolation);
    expect(e1.message).toBe("This detail was written off and cannot be billed");
    const gone = await mk();
    await db.update(jobs).set({ state: "canceled" }).where(eq(jobs.id, gone.job.id));
    const e2 = await bill(gone.person, gone.a.id, input(gone.job)).catch((e) => e);
    expect(e2).toBeInstanceOf(RuleViolation);
    expect(e2.message).toBe("This detail was canceled and cannot be billed");
    expect(await invoiceCount(off.a.id)).toBe(0);
    expect(await invoiceCount(gone.a.id)).toBe(0);
  });

  test("billing is audited", async () => {
    const { a, job, person } = await mk();
    const r = await bill(person, a.id, input(job));
    const rows = await get().db.select().from(auditLog).where(eq(auditLog.entityId, a.id));
    expect(rows.map((x) => x.action)).toContain("assignment.bill");
    const inv = await get().db.select().from(auditLog).where(eq(auditLog.entityId, r.invoice.id));
    expect(inv.map((x) => x.action)).toContain("invoice.create");
  });

  test("incomplete email settings roll the whole billing back and surface the settings message", async () => {
    await setSettings({ billingReplyToEmail: "" });
    const { a, job, person } = await mk();
    const err = await bill(person, a.id, input(job)).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toMatch(/reply-to/i);
    expect(await invoiceCount(a.id)).toBe(0);
    const [row] = await get().db.select().from(assignments).where(eq(assignments.id, a.id));
    expect(row.status).toBe("signed_up");
    expect(row.billedAt).toBeNull();
  });
});
