import { describe, expect, test } from "vitest";
import { billingLockStatus, reminderDue } from "@/domain/billing/lock";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const now = new Date("2036-03-10T15:00:00Z");
const ago = (ms: number) => new Date(now.getTime() - ms);
const s = {
  unbilledGraceHours: 24,
  billingLockEnabled: true,
  paymentAckLockMode: "vendor_reported" as "off" | "vendor_reported" | "all_invoices",
  responseDays: { vendor: 30, deputy: 30, coordinator: 7 },
};
type Inv = Parameters<typeof billingLockStatus>[0]["unacknowledged"][number];
const inv = (o: Partial<Inv> = {}): Inv => ({
  sentAt: ago(60 * DAY),
  deputyPaidAt: null,
  responsibleParty: "vendor",
  responsibleSince: ago(60 * DAY),
  hasOpenIssue: false,
  ...o,
});
const run = (o: Partial<Omit<Parameters<typeof billingLockStatus>[0], "s">> & { s?: Partial<typeof s> } = {}) =>
  billingLockStatus({ unbilled: [], unacknowledged: [], now, override: null, ...o, s: { ...s, ...o.s } });

describe("unbilled details", () => {
  test("ended 23 hours ago with grace 24 does not lock", () => {
    expect(run({ unbilled: [{ endAt: ago(23 * HOUR) }] })).toEqual({ locked: false, unbilledCount: 0, unacknowledgedCount: 0 });
  });
  test("ended 25 hours ago locks with unbilledCount 1", () => {
    expect(run({ unbilled: [{ endAt: ago(25 * HOUR) }] })).toEqual({ locked: true, unbilledCount: 1, unacknowledgedCount: 0 });
  });
  test("lock disabled never locks for unbilled", () => {
    expect(run({ unbilled: [{ endAt: ago(99 * HOUR) }], s: { billingLockEnabled: false } }).locked).toBe(false);
  });
});

describe("payment acknowledgment", () => {
  const vendorPaid = (days: number) => inv({ responsibleParty: "deputy", responsibleSince: ago(days * DAY) });
  test("vendor-marked-paid invoice 29 days old does not lock, 30 days locks", () => {
    expect(run({ unacknowledged: [vendorPaid(29)] }).locked).toBe(false);
    expect(run({ unacknowledged: [vendorPaid(30)] })).toEqual({ locked: true, unbilledCount: 0, unacknowledgedCount: 1 });
  });
  test("vendor_reported: an unpaid invoice with no vendor mark never locks", () => {
    expect(run({ unacknowledged: [inv()] }).locked).toBe(false);
  });
  test("all_invoices: a sent invoice 30 days old locks, 29 does not", () => {
    const m = { paymentAckLockMode: "all_invoices" as const, responseDays: { vendor: 15, deputy: 15, coordinator: 7 } };
    expect(run({ unacknowledged: [inv({ sentAt: ago(30 * DAY) })], s: m })).toMatchObject({ locked: true, unacknowledgedCount: 1 });
    expect(run({ unacknowledged: [inv({ sentAt: ago(29 * DAY) })], s: m }).locked).toBe(false);
  });
  test("all_invoices: an invoice the person already marked paid does not count", () => {
    expect(run({ unacknowledged: [inv({ deputyPaidAt: ago(DAY) })], s: { paymentAckLockMode: "all_invoices" } }).locked).toBe(false);
  });
  test("an open payment issue clears the item in both modes", () => {
    expect(run({ unacknowledged: [{ ...vendorPaid(40), hasOpenIssue: true }] }).locked).toBe(false);
    expect(run({ unacknowledged: [inv({ hasOpenIssue: true })], s: { paymentAckLockMode: "all_invoices" } }).locked).toBe(false);
  });
  test("mode off never locks for payment", () => {
    expect(run({ unacknowledged: [vendorPaid(90)], s: { paymentAckLockMode: "off" } }).locked).toBe(false);
  });
  test("both counts together", () => {
    expect(run({ unbilled: [{ endAt: ago(30 * HOUR) }], unacknowledged: [vendorPaid(31)] })).toEqual({ locked: true, unbilledCount: 1, unacknowledgedCount: 1 });
  });
});

describe("override", () => {
  test("an override until tomorrow unlocks", () => {
    const until = new Date(now.getTime() + DAY);
    expect(run({ unbilled: [{ endAt: ago(99 * HOUR) }], override: { until } }).locked).toBe(false);
  });
  test("an expired override does not unlock", () => {
    expect(run({ unbilled: [{ endAt: ago(99 * HOUR) }], override: { until: ago(HOUR) } }).locked).toBe(true);
  });
});

describe("reminderDue (agency calendar days)", () => {
  test("never sent is due", () => {
    expect(reminderDue(null, "weekly", now)).toBe(true);
  });
  test("daily: sent earlier today is not due; any earlier agency date is, even 30 seconds early", () => {
    expect(reminderDue(ago(HOUR), "daily", now)).toBe(false);
    expect(reminderDue(new Date(now.getTime() - DAY + 30_000), "daily", now)).toBe(true);
  });
  test("every other day: yesterday is not due, two agency days ago is (30 seconds early still sends)", () => {
    expect(reminderDue(ago(DAY), "every_other_day", now)).toBe(false);
    expect(reminderDue(new Date(now.getTime() - 2 * DAY + 30_000), "every_other_day", now)).toBe(true);
  });
  test("weekly: 6 days is not due, 7 is", () => {
    expect(reminderDue(ago(6 * DAY), "weekly", now)).toBe(false);
    expect(reminderDue(new Date(now.getTime() - 7 * DAY + 30_000), "weekly", now)).toBe(true);
  });
  test("the day boundary is agency midnight, not UTC", () => {
    // 04:30Z is 23:30 the previous day in Chicago (CDT); 05:30Z is 00:30 the next day.
    expect(reminderDue(new Date("2036-03-10T04:30:00Z"), "daily", new Date("2036-03-10T05:30:00Z"))).toBe(true);
    expect(reminderDue(new Date("2036-03-10T05:10:00Z"), "daily", new Date("2036-03-10T20:00:00Z"))).toBe(false);
  });
});
