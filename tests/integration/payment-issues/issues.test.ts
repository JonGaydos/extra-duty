import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoiceEvents, invoices, notifications, paymentIssueNotes, paymentIssues, paymentMethods, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { applyResponsibility, invoiceTimeline, isOverdue, markPaid, vendorMarkPaid } from "@/domain/billing/payments";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { createInvoice, formatInvoiceNumber } from "@/domain/invoices/invoices";
import {
  addIssueNote,
  canReportNonPayment,
  closeIssue,
  getPaymentIssue,
  reportNonPayment,
  setIssueWaitingOn,
  vendorIssueHistory,
} from "@/domain/payment-issues/issues";
import { getSettings, updateSettings } from "@/domain/settings/settings";
import { responseDeadlinesTick } from "@/jobs/vendor-reminders";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender, type MemorySender } from "@/lib/email/types";

const DAY = 86_400_000;
const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
const SINCE = new Date("2036-02-01T15:00:00Z");
const PAID = new Date("2036-01-05T12:00:00Z");

describe("payment issues", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let vendor: Actor;
  let coord: Actor;
  let method: string;
  let sender: MemorySender;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-issues-"));
    sender = createMemorySender();
    setEmailSender(sender);
    fx = await setupFixture(db, "iss");
    coord = fx.coord;
    admin = (await makeUser(db, "admin", "iss-admin@example.test")).actor;
    vendor = { ...(await makeUser(db, "vendor", "iss-vendor@example.test")).actor, vendorId: fx.vendorId };
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(eq(vendors.id, fx.vendorId));
    [{ id: method }] = await db.select({ id: paymentMethods.id }).from(paymentMethods).limit(1);
  });

  const tx = <T>(fn: (t: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);

  beforeEach(async () => {
    sender.clear();
    await tx((t) =>
      updateSettings(admin, t, {
        email: GOOD_EMAIL,
        billingReplyToEmail: "billing@sheriff.example",
        responseDays: { vendor: 30, deputy: 30, coordinator: 7 },
        vendorReminderEnabled: false,
      }),
    );
  });

  async function mk(o: { since?: Date; vendorPaid?: boolean } = {}) {
    const { db } = get();
    const person = await fx.person();
    const { job, positionId } = await fx.mkJob();
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "billed" }).returning();
    const created = await tx((t) => createInvoice(t, { assignmentId: a.id, minutes: 360, rateCents: 7000, status: "sent" }));
    const since = o.since ?? SINCE;
    await db.update(invoices).set({ sentAt: since }).where(eq(invoices.id, created.id));
    if (o.vendorPaid) await tx((t) => vendorMarkPaid(vendor, t, created.id, { paymentMethodId: method, reference: "1042", paidAt: PAID, note: "Check mailed Tuesday" }, since));
    await tx((t) => applyResponsibility(t, created.id, since));
    const inv = (await db.select().from(invoices).where(eq(invoices.id, created.id)))[0];
    return { inv, person, job };
  }
  const reload = async (id: string) => (await get().db.select().from(invoices).where(eq(invoices.id, id)))[0];
  const events = (id: string) => get().db.select().from(invoiceEvents).where(eq(invoiceEvents.invoiceId, id));
  const inbox = (userId: string, type: string, link?: string) =>
    get().db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, type), ...(link ? [eq(notifications.link, link)] : [])));
  const openIssue = async (o: { since?: Date } = {}) => {
    const m = await mk({ vendorPaid: true, ...o });
    const issue = await tx((t) => reportNonPayment(m.person, t, m.inv.id, "Never arrived", o.since ?? SINCE));
    return { ...m, issue };
  };

  test("reporting is refused inside the vendor's response time and allowed on day 30", async () => {
    const { inv, person } = await mk();
    const open = { ...inv, hasOpenIssue: false };
    const s = { responseDays: { vendor: 30, deputy: 30, coordinator: 7 } };
    expect(canReportNonPayment(open, new Date(SINCE.getTime() + 29 * DAY), s)).toBe(false);
    expect(canReportNonPayment(open, new Date(SINCE.getTime() + 30 * DAY), s)).toBe(true);
    expect(canReportNonPayment({ ...open, hasOpenIssue: true }, new Date(SINCE.getTime() + 31 * DAY), s)).toBe(false);
    expect(canReportNonPayment({ ...open, deputyPaidAt: PAID }, new Date(SINCE.getTime() + 31 * DAY), s)).toBe(false);

    await expect(tx((t) => reportNonPayment(person, t, inv.id, undefined, new Date(SINCE.getTime() + 29 * DAY)))).rejects.toBeInstanceOf(RuleViolation);
    const issue = await tx((t) => reportNonPayment(person, t, inv.id, undefined, new Date(SINCE.getTime() + 30 * DAY)));
    expect(issue.status).toBe("open");
    expect(issue.note).toBeNull();
  });

  test("reporting is allowed once the vendor marked paid, and the issue shows the vendor's paid note", async () => {
    const { inv, person } = await mk({ vendorPaid: true });
    const issue = await tx((t) => reportNonPayment(person, t, inv.id, "Never arrived", new Date(SINCE.getTime() + DAY)));
    const view = await tx((t) => getPaymentIssue(person, t, issue.id));
    expect(view.vendorPaid?.note).toBe("Check mailed Tuesday");
    expect(view.note).toBe("Never arrived");
    expect(view.status).toBe("open");
  });

  test("a new issue makes the coordinator responsible, alerts coordinators with the invoice link and is on the timeline", async () => {
    const { inv, person } = await mk({ vendorPaid: true });
    const at = new Date(SINCE.getTime() + DAY);
    await tx((t) => reportNonPayment(person, t, inv.id, "Never arrived", at));
    const cur = await reload(inv.id);
    expect(cur.responsibleParty).toBe("coordinator");
    expect(cur.responsibleSince!.getTime()).toBe(at.getTime());
    const link = `/invoices/${inv.id}`;
    expect(await inbox(coord.userId, "payment_issue.opened", link)).toHaveLength(1);
    expect(await inbox(admin.userId, "payment_issue.opened", link)).toHaveLength(1);
    expect(await inbox(person.userId, "payment_issue.opened")).toHaveLength(0);
    const names = (await events(inv.id)).map((e) => e.event);
    expect(names).toContain("issue_opened");
    expect(names).toContain("responsibility");
    const [aud] = await get().db.select().from(auditLog).where(eq(auditLog.action, "paymentIssue.report")).limit(1);
    expect(aud).toBeTruthy();
  });

  test("only the payee reports, only one issue is open, vendors cannot", async () => {
    const { inv, person } = await mk({ vendorPaid: true });
    const other = await fx.person();
    await expect(tx((t) => reportNonPayment(other, t, inv.id, undefined, SINCE))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => reportNonPayment(coord, t, inv.id, undefined, SINCE))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => reportNonPayment(vendor, t, inv.id, undefined, SINCE))).rejects.toBeInstanceOf(ForbiddenError);
    await tx((t) => reportNonPayment(person, t, inv.id, undefined, SINCE));
    await expect(tx((t) => reportNonPayment(person, t, inv.id, undefined, SINCE))).rejects.toThrow("A payment issue is already open");
  });

  test("the person sees status and shared notes but never internal ones; vendors see no issue", async () => {
    const { inv, person, issue } = await openIssue();
    const stranger = await fx.person();
    await tx((t) => addIssueNote(coord, t, issue.id, "Left voicemail with vendor", "deputy", SINCE));
    await tx((t) => addIssueNote(coord, t, issue.id, "Vendor owner is hostile, escalate to sheriff", "internal", SINCE));
    await tx((t) => addIssueNote(person, t, issue.id, "Called them too", "deputy", SINCE));
    await expect(tx((t) => addIssueNote(person, t, issue.id, "sneaky", "internal", SINCE))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => addIssueNote(stranger, t, issue.id, "x", "deputy", SINCE))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => addIssueNote(coord, t, issue.id, "   ", "deputy", SINCE))).rejects.toBeInstanceOf(ValidationError);

    const mine = await tx((t) => getPaymentIssue(person, t, issue.id));
    expect(mine.notes.map((n) => n.note)).toEqual(["Left voicemail with vendor", "Called them too"]);
    const staff = await tx((t) => getPaymentIssue(coord, t, issue.id));
    expect(staff.notes).toHaveLength(3);
    expect(staff.vendorContact?.billingEmails).toEqual(["ap@vendor.example"]);
    expect(JSON.stringify(mine)).not.toContain("hostile");
    expect(mine).not.toHaveProperty("vendorContact");
    await expect(tx((t) => getPaymentIssue(vendor, t, issue.id))).rejects.toBeInstanceOf(ForbiddenError);

    const personTimeline = await tx((t) => invoiceTimeline(person, t, inv.id));
    expect(JSON.stringify(personTimeline)).not.toContain("hostile");
    expect(personTimeline.filter((e) => e.event === "issue_note")).toHaveLength(3);
    const staffTimeline = await tx((t) => invoiceTimeline(coord, t, inv.id));
    expect(staffTimeline.filter((e) => e.event === "issue_note")).toHaveLength(3);
  });

  test("waiting on the vendor moves responsibility, emails the vendor the vendor-visible note only and shows the vendor one event", async () => {
    const { inv, issue } = await openIssue();
    await tx((t) => addIssueNote(coord, t, issue.id, "Internal: vendor owes us from last year", "internal", SINCE));
    const at = new Date(SINCE.getTime() + 2 * DAY);
    await tx((t) => setIssueWaitingOn(coord, t, issue.id, "vendor", "Please confirm the check number", at));
    const cur = await reload(inv.id);
    expect(cur.responsibleParty).toBe("vendor");
    expect(cur.responsibleSince!.getTime()).toBe(at.getTime());
    await drain();
    const mail = sender.sent.filter((m) => m.to.includes("ap@vendor.example") && m.text.includes(formatInvoiceNumber("ED-", inv.number)));
    expect(mail).toHaveLength(1);
    expect(mail[0].text).toContain("Please confirm the check number");
    expect(mail[0].text).not.toContain("owes us");
    expect(mail[0].replyTo).toBe("billing@sheriff.example");

    const [stored] = await get().db.select().from(paymentIssueNotes).where(eq(paymentIssueNotes.note, "Please confirm the check number"));
    expect(stored.visibility).toBe("vendor");
    const v = await tx((t) => invoiceTimeline(vendor, t, inv.id));
    const waiting = v.filter((e) => e.event === "issue_waiting_on");
    expect(waiting).toHaveLength(1);
    expect(waiting[0].note).toBeNull();
    expect(v.map((e) => e.event)).not.toContain("issue_opened");
    expect(v.map((e) => e.event)).not.toContain("issue_note");
    expect(JSON.stringify(v)).not.toContain("confirm the check");
    const p = await get().db.select().from(invoiceEvents).where(and(eq(invoiceEvents.invoiceId, inv.id), eq(invoiceEvents.event, "issue_opened")));
    expect(p[0].vendorVisible).toBe(false);
  });

  test("waiting on the person alerts them; waiting on a coordinator alerts coordinators; only coordinators change it", async () => {
    const { inv, person, issue } = await openIssue();
    await tx((t) => setIssueWaitingOn(coord, t, issue.id, "deputy", "Send us the envelope photo", SINCE));
    expect((await reload(inv.id)).responsibleParty).toBe("deputy");
    const got = await inbox(person.userId, "payment_issue.waiting_on");
    expect(got).toHaveLength(1);
    expect(got[0].link).toBe(`/invoices/${inv.id}`);
    expect(got[0].body).toContain("Send us the envelope photo");
    await tx((t) => setIssueWaitingOn(admin, t, issue.id, "coordinator", undefined, SINCE));
    expect((await reload(inv.id)).responsibleParty).toBe("coordinator");
    expect(await inbox(coord.userId, "payment_issue.waiting_on")).toHaveLength(1);
    await expect(tx((t) => setIssueWaitingOn(person, t, issue.id, "vendor", undefined, SINCE))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("both sides marking paid closes the issue as paid", async () => {
    const { inv, person, issue } = await openIssue();
    await tx((t) => markPaid(person, t, inv.id, { paymentMethodId: method, reference: "9", paidAt: PAID }, new Date(SINCE.getTime() + 3 * DAY)));
    const [row] = await get().db.select().from(paymentIssues).where(eq(paymentIssues.id, issue.id));
    expect(row.status).toBe("paid");
    expect(row.closedAt).toBeTruthy();
    expect((await reload(inv.id)).status).toBe("paid");
    expect((await events(inv.id)).map((e) => e.event)).toContain("issue_closed");
    expect(await inbox(person.userId, "payment_issue.closed")).toHaveLength(0);
  });

  test("closeIssue: resolved closes only the issue, paid closes the invoice, written off needs a note; the person is alerted", async () => {
    const a = await openIssue();
    await tx((t) => closeIssue(coord, t, a.issue.id, "resolved", "Vendor will pay next cycle", SINCE));
    const cur = await reload(a.inv.id);
    expect(cur.status).toBe("sent");
    expect(cur.responsibleParty).toBe("deputy");
    const [ra] = await get().db.select().from(paymentIssues).where(eq(paymentIssues.id, a.issue.id));
    expect(ra.status).toBe("resolved");
    expect(await inbox(a.person.userId, "payment_issue.closed")).toHaveLength(1);
    await expect(tx((t) => closeIssue(coord, t, a.issue.id, "resolved", undefined, SINCE))).rejects.toBeInstanceOf(RuleViolation);
    const view = await tx((t) => getPaymentIssue(a.person, t, a.issue.id));
    expect(view.status).toBe("resolved");
    expect(view.notes.map((n) => n.note)).toContain("Vendor will pay next cycle");

    const b = await openIssue();
    await tx((t) => closeIssue(coord, t, b.issue.id, "paid", "Vendor confirmed by phone", SINCE));
    expect((await reload(b.inv.id)).status).toBe("paid");
    expect((await get().db.select().from(paymentIssues).where(eq(paymentIssues.id, b.issue.id)))[0].status).toBe("paid");
    expect(await inbox(b.person.userId, "payment_issue.closed")).toHaveLength(1);

    const c = await openIssue();
    await expect(tx((t) => closeIssue(coord, t, c.issue.id, "written_off", "  ", SINCE))).rejects.toBeInstanceOf(ValidationError);
    await expect(tx((t) => closeIssue(c.person, t, c.issue.id, "resolved", undefined, SINCE))).rejects.toBeInstanceOf(ForbiddenError);
    await tx((t) => closeIssue(admin, t, c.issue.id, "written_off", "Vendor out of business", SINCE));
    expect((await reload(c.inv.id)).status).toBe("written_off");
    expect((await get().db.select().from(paymentIssues).where(eq(paymentIssues.id, c.issue.id)))[0].status).toBe("written_off");
    const ev = (await events(c.inv.id)).filter((e) => e.event === "issue_closed");
    expect(ev).toHaveLength(1);
    expect(ev[0].note).toContain("Written off");
  });

  test("vendorIssueHistory lists a vendor's issues with dates, amounts and outcomes, for coordinators and admins only", async () => {
    const a = await openIssue();
    await tx((t) => closeIssue(coord, t, a.issue.id, "resolved", undefined, new Date(SINCE.getTime() + DAY)));
    const b = await openIssue();
    const rows = await tx((t) => vendorIssueHistory(coord, t, fx.vendorId));
    const ra = rows.find((r) => r.issueId === a.issue.id)!;
    const rb = rows.find((r) => r.issueId === b.issue.id)!;
    expect(ra.status).toBe("resolved");
    expect(ra.totalCents).toBe(42000);
    expect(ra.closedAt!.getTime()).toBe(SINCE.getTime() + DAY);
    expect(ra.openedAt.getTime()).toBe(SINCE.getTime());
    expect(rb.status).toBe("open");
    expect(rb.closedAt).toBeNull();
    expect(rows.indexOf(rb)).toBeLessThan(rows.indexOf(ra));
    expect(await tx((t) => vendorIssueHistory(admin, t, fx.vendorId))).toHaveLength(rows.length);
    await expect(tx((t) => vendorIssueHistory(a.person, t, fx.vendorId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(tx((t) => vendorIssueHistory(vendor, t, fx.vendorId))).rejects.toBeInstanceOf(ForbiddenError);
  });

  describe("responseDeadlinesTick", () => {
    const reminders = (number: number) => sender.sent.filter((m) => m.subject === `Payment reminder: invoice ${formatInvoiceNumber("ED-", number)}`);
    const overdueEvents = async (id: string) => (await events(id)).filter((e) => e.event === "overdue");

    test("the vendor reminder sends once when the vendor goes overdue, and never when disabled", async () => {
      const off = await mk({ since: new Date("2036-03-01T15:00:00Z") });
      const due = new Date(off.inv.responsibleSince!.getTime() + 30 * DAY + 1000);
      await responseDeadlinesTick(due);
      await drain();
      expect(reminders(off.inv.number)).toHaveLength(0);
      expect(await overdueEvents(off.inv.id)).toHaveLength(1);

      await tx((t) => updateSettings(admin, t, { vendorReminderEnabled: true }));
      const on = await mk({ since: new Date("2036-04-01T15:00:00Z") });
      const before = new Date(on.inv.responsibleSince!.getTime() + 29 * DAY);
      await responseDeadlinesTick(before);
      await drain();
      expect(reminders(on.inv.number)).toHaveLength(0);
      expect(await overdueEvents(on.inv.id)).toHaveLength(0);

      const after = new Date(on.inv.responsibleSince!.getTime() + 30 * DAY + 1000);
      await responseDeadlinesTick(after);
      await responseDeadlinesTick(new Date(after.getTime() + DAY));
      await drain();
      const sent = reminders(on.inv.number);
      expect(sent).toHaveLength(1);
      expect(sent[0].to).toEqual(["ap@vendor.example"]);
      expect(sent[0].replyTo).toBe("billing@sheriff.example");
      expect(sent[0].text).toContain(formatInvoiceNumber("ED-", on.inv.number));
      expect(sent[0].text).toContain(on.job.title);
      expect(sent[0].text).toContain("$420.00");
      const [payee] = await get().db.select().from(users).where(eq(users.id, on.person.userId));
      expect(sent[0].text).toContain(payee.name);
      expect(sent[0].text).toContain((await tx((t) => getSettings(t))).agency.name);
      const ev = await overdueEvents(on.inv.id);
      expect(ev).toHaveLength(1);
      expect(ev[0].party).toBe("vendor");
      expect(ev[0].vendorVisible).toBe(false);
    });

    test("a coordinator-owned issue untouched for 7 days alerts coordinators and admins once and shows overdue", async () => {
      const { inv } = await openIssue();
      const link = `/invoices/${inv.id}`;
      const at = new Date(SINCE.getTime() + 7 * DAY + 1000);
      await responseDeadlinesTick(new Date(SINCE.getTime() + 6 * DAY));
      expect(await inbox(coord.userId, "payment_issue.overdue", link)).toHaveLength(0);
      await responseDeadlinesTick(at);
      await responseDeadlinesTick(new Date(at.getTime() + DAY));
      expect(await inbox(coord.userId, "payment_issue.overdue", link)).toHaveLength(1);
      expect(await inbox(admin.userId, "payment_issue.overdue", link)).toHaveLength(1);
      const cur = await reload(inv.id);
      const s = await tx((t) => getSettings(t));
      expect(isOverdue(cur, at, s)).toBe(true);
      const ev = (await events(inv.id)).filter((e) => e.event === "overdue");
      expect(ev).toHaveLength(1);
      expect(ev[0].party).toBe("coordinator");

      // Responsibility moves to the vendor and back to a coordinator: a new stretch earns a new overdue event.
      const t2 = new Date(at.getTime() + 10 * DAY);
      const iid = (await get().db.select().from(paymentIssues).where(eq(paymentIssues.invoiceId, inv.id)))[0].id;
      await tx((t) => setIssueWaitingOn(coord, t, iid, "coordinator", undefined, t2));
      await tx((t) => setIssueWaitingOn(coord, t, iid, "vendor", undefined, t2));
      await tx((t) => setIssueWaitingOn(coord, t, iid, "coordinator", undefined, new Date(t2.getTime() + DAY)));
      await responseDeadlinesTick(new Date(t2.getTime() + DAY + 8 * DAY));
      expect((await events(inv.id)).filter((e) => e.event === "overdue")).toHaveLength(2);
      expect(await inbox(coord.userId, "payment_issue.overdue", link)).toHaveLength(2);
    });

    test("changing responseDays.coordinator to 3 moves that deadline", async () => {
      const { inv } = await openIssue({ since: new Date("2036-05-01T15:00:00Z") });
      const since = (await reload(inv.id)).responsibleSince!;
      const link = `/invoices/${inv.id}`;
      const now = new Date(since.getTime() + 4 * DAY);
      await responseDeadlinesTick(now);
      expect(await inbox(coord.userId, "payment_issue.overdue", link)).toHaveLength(0);
      await tx((t) => updateSettings(admin, t, { responseDays: { vendor: 30, deputy: 30, coordinator: 3 } }));
      await responseDeadlinesTick(now);
      expect(await inbox(coord.userId, "payment_issue.overdue", link)).toHaveLength(1);
    });

    test("a deputy-owned invoice gets an overdue event but no alert or email", async () => {
      const { inv, person } = await mk({ since: new Date("2036-06-01T15:00:00Z"), vendorPaid: true });
      await tx((t) => updateSettings(admin, t, { vendorReminderEnabled: true }));
      await responseDeadlinesTick(new Date(inv.responsibleSince!.getTime() + 31 * DAY));
      await drain();
      expect((await overdueEvents(inv.id)).map((e) => e.party)).toEqual(["deputy"]);
      expect(reminders(inv.number)).toHaveLength(0);
      expect(await inbox(person.userId, "payment_issue.overdue")).toHaveLength(0);
    });
  });
});
