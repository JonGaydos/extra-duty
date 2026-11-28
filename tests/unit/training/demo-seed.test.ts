import { describe, expect, test } from "vitest";
import { assignmentStatus, invoiceStatus, jobState } from "@/db/schema";
import { buildDemoData } from "@/db/demo-seed";
import { DEFAULT_SETTINGS } from "@/domain/settings/defaults";
import { agencySettingsSchema } from "@/domain/settings/settings";
import { agencyDateParts, agencyInstant, agencyMonthKey } from "@/domain/time/agency-time";
import { PRACTICE_USER_EMAILS } from "@/domain/training/mode";

/** Agency month keys from `offset` months away from `today`'s month. */
function monthKey(today: Date, offset: number): string {
  const p = agencyDateParts(today);
  return agencyMonthKey(agencyInstant(p.year, p.month + offset, 1, 12, 0));
}

// A normal day, the first and last of a month, a leap day, a spring-forward day, New Year's Eve late at night.
const DATES = [
  new Date("2026-11-25T15:00:00Z"),
  agencyInstant(2026, 12, 1, 0, 30),
  agencyInstant(2026, 11, 30, 23, 30),
  agencyInstant(2028, 2, 29, 9, 0),
  agencyInstant(2027, 3, 14, 3, 30),
  agencyInstant(2026, 12, 31, 23, 50),
];

describe("buildDemoData", () => {
  test.each(DATES.map((d) => [d.toISOString(), d] as const))("for %s every month from 12 back to 3 ahead has at least 10 details", (_label, today) => {
    const data = buildDemoData(today);
    const perMonth = new Map<string, number>();
    for (const j of data.jobs) perMonth.set(agencyMonthKey(j.startAt), (perMonth.get(agencyMonthKey(j.startAt)) ?? 0) + 1);
    for (let offset = -12; offset <= 3; offset++) {
      expect(perMonth.get(monthKey(today, offset)) ?? 0, `month ${monthKey(today, offset)}`).toBeGreaterThanOrEqual(10);
    }
  });

  test.each(DATES.map((d) => [d.toISOString(), d] as const))("for %s every job, assignment and invoice state is present", (_label, today) => {
    const data = buildDemoData(today);
    expect(new Set(data.jobs.map((j) => j.state))).toEqual(new Set(jobState.enumValues));
    expect(new Set(data.assignments.map((a) => a.status))).toEqual(new Set(assignmentStatus.enumValues));
    expect(new Set(data.invoices.map((i) => i.status))).toEqual(new Set(invoiceStatus.enumValues));
  });

  test.each(DATES.map((d) => [d.toISOString(), d] as const))("for %s nothing is billed before its detail ends, and money and minutes are integers", (_label, today) => {
    const data = buildDemoData(today);
    const job = new Map(data.jobs.map((j) => [j.id, j]));
    const assignment = new Map(data.assignments.map((a) => [a.id, a]));
    for (const inv of data.invoices) {
      const a = assignment.get(inv.assignmentId)!;
      expect(a, "invoice assignment").toBeTruthy();
      expect(job.get(a.jobId)!.endAt.getTime()).toBeLessThanOrEqual(today.getTime());
      for (const n of [inv.minutes, inv.rateCents, inv.totalCents]) expect(Number.isInteger(n)).toBe(true);
    }
    for (const j of data.jobs) expect(Number.isInteger(j.rateCents)).toBe(true);
  });

  test.each(DATES.map((d) => [d.toISOString(), d] as const))("for %s an upcoming confidential detail is never released, has the practice deputy assigned and an audited reason", (_label, today) => {
    const data = buildDemoData(today);
    const practice = data.users.find((u) => u.email === PRACTICE_USER_EMAILS.deputy)!;
    const secret = data.jobs.filter((j) => j.confidential && j.startAt.getTime() > today.getTime());
    expect(secret.length).toBeGreaterThan(0);
    for (const j of secret) {
      expect(j).toMatchObject({ held: false, releaseAt: null });
      expect(data.assignments.some((a) => a.jobId === j.id && a.userId === practice.id && a.status === "signed_up")).toBe(true);
      expect(data.audit.some((a) => a.action === "job.confidential_on" && a.entityId === j.id && a.reason)).toBe(true);
    }
  });

  test("the made-up agency has about 20 vendors, about 30 deputies across every rank, a dispatcher, coordinators and an admin", () => {
    const data = buildDemoData(DATES[0]);
    expect(data.vendors.length).toBeGreaterThanOrEqual(18);
    const personnel = data.users.filter((u) => u.role === "personnel");
    expect(personnel.length).toBeGreaterThanOrEqual(28);
    expect(new Set(personnel.map((u) => u.rank))).toEqual(new Set(["Posse", "CSO", "Deputy Sheriff", "Dispatcher"]));
    expect(data.users.filter((u) => u.role === "coordinator").length).toBeGreaterThanOrEqual(2);
    expect(data.users.filter((u) => u.role === "admin").length).toBeGreaterThanOrEqual(1);
    const emails = new Set(data.users.map((u) => u.email));
    for (const email of Object.values(PRACTICE_USER_EMAILS)) expect(emails.has(email)).toBe(true);
    // Made-up addresses only: nothing in the demo can reach a real inbox.
    for (const e of [...emails, ...data.vendors.flatMap((v) => v.billingEmails ?? [])]) expect(e).toMatch(/\.example$/);
  });

  test("the owner's states are there: reactivated, approved and not sent, paid and sent as paid, batched, suspension removals, site contacts and notification settings", () => {
    const data = buildDemoData(DATES[0]);
    const reactivated = data.audit.filter((a) => a.action === "job.reactivate").map((a) => a.entityId);
    expect(reactivated.length).toBeGreaterThan(0);
    for (const id of reactivated) expect(data.audit.some((a) => a.action === "job.cancel" && a.entityId === id)).toBe(true);
    expect(data.invoices.some((i) => i.status === "approved_unsent" && i.emailStatus === "not_queued")).toBe(true);
    expect(data.invoices.some((i) => i.status === "paid" && i.sentAt && i.deputyPaidAt && i.emailStatus === "sent")).toBe(true);
    const batched = data.invoices.filter((i) => i.batchId);
    expect(batched.length).toBeGreaterThan(1);
    for (const i of batched) expect(data.invoiceBatches.some((b) => b.id === i.batchId)).toBe(true);
    expect(data.assignments.some((a) => a.status === "removed" && a.removalReason === "Suspended")).toBe(true);
    expect(data.users.some((u) => u.suspensionReason)).toBe(true);
    expect(data.vendorContacts.length).toBeGreaterThanOrEqual(data.vendors.length);
    expect(Object.keys(data.settings.notificationChannels ?? {}).length).toBeGreaterThan(0);
    expect(() => agencySettingsSchema.parse({ ...DEFAULT_SETTINGS, ...data.settings })).not.toThrow();
  });

  test("the next 3 months carry open, filled, backup, pending shorter, flexible-time, officer-safety, on-hold and held details", () => {
    const today = DATES[0];
    const data = buildDemoData(today);
    const future = data.jobs.filter((j) => j.startAt > today);
    const futureIds = new Set(future.map((j) => j.id));
    const held = new Set(data.vendors.filter((v) => v.paymentHold).map((v) => v.id));
    expect(future.some((j) => j.flexEarliestStartAt && j.flexLatestEndAt)).toBe(true);
    expect(future.some((j) => j.held)).toBe(true);
    expect(future.some((j) => held.has(j.vendorId))).toBe(true);
    expect(data.jobSafety.some((s) => futureIds.has(s.jobId))).toBe(true);
    for (const status of ["signed_up", "backup", "pending_short"] as const) {
      expect(data.assignments.some((a) => a.status === status && futureIds.has(a.jobId)), status).toBe(true);
    }
    // Past details include agreed ops plans and payment issues.
    expect(data.opsPlans.some((p) => p.status === "agreed")).toBe(true);
    expect(data.paymentIssues.length).toBeGreaterThan(0);
  });

  test.each(DATES.map((d) => [d.toISOString(), d] as const))(
    "for %s the practice deputy is the Incident Commander on an upcoming detail with an ops plan due",
    (_label, today) => {
      const data = buildDemoData(today);
      const deputy = data.users.find((u) => u.email === PRACTICE_USER_EMAILS.deputy)!;
      const due = data.opsPlans.filter((p) => p.status === "due").map((p) => p.jobId);
      const jobs = data.jobs.filter((j) => due.includes(j.id) && j.startAt > today && j.opsPlanRequired);
      const icPositions = new Set(data.jobPositions.filter((p) => p.positionType === "Incident Commander").map((p) => p.id));
      const mine = jobs.filter((j) =>
        data.assignments.some((a) => a.jobId === j.id && a.userId === deputy.id && a.status === "signed_up" && icPositions.has(a.jobPositionId)),
      );
      expect(mine.length).toBeGreaterThan(0);
    },
  );
});
