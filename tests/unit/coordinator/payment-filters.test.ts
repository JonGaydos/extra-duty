import { describe, expect, test } from "vitest";
import { activePaymentFilters, matchesBoardRow, matchesNotConfirmedRow, parsePaymentFilters, type PaymentFilterRow } from "@/domain/coordinator/payment-filters";

const row = (o: Partial<PaymentFilterRow> = {}): PaymentFilterRow => ({
  party: "vendor",
  overdue: false,
  vendorReportsPaid: false,
  vendorOnHold: false,
  day: 3,
  vendorId: "v1",
  payeeUserId: "d1",
  issuedAt: new Date("2026-11-10T18:00:00Z"),
  totalCents: 28000,
  sent: true,
  ...o,
});

describe("Payments filters", () => {
  test("nothing chosen matches every unpaid invoice and no deputy-confirmed one", () => {
    const f = parsePaymentFilters({});
    expect(activePaymentFilters(f)).toBe(0);
    expect(matchesBoardRow(row(), f)).toBe(true);
    expect(matchesNotConfirmedRow(row(), f)).toBe(false);
  });

  test("status: any checked turn or flag matches; Vendor not confirmed brings in only those invoices", () => {
    const f = parsePaymentFilters({ status: ["deputy", "overdue"] });
    expect(matchesBoardRow(row({ party: "deputy" }), f)).toBe(true);
    expect(matchesBoardRow(row({ party: "vendor", overdue: true }), f)).toBe(true);
    expect(matchesBoardRow(row({ party: "vendor" }), f)).toBe(false);
    expect(matchesBoardRow(row({ vendorReportsPaid: true }), parsePaymentFilters({ status: "vendor_paid" }))).toBe(true);
    expect(matchesBoardRow(row({ vendorOnHold: true }), parsePaymentFilters({ status: "hold" }))).toBe(true);
    const nc = parsePaymentFilters({ status: "not_confirmed" });
    expect(matchesBoardRow(row(), nc)).toBe(false);
    expect(matchesNotConfirmedRow(row(), nc)).toBe(true);
    expect(parsePaymentFilters({ status: ["bogus"] }).statuses).toEqual([]);
  });

  test("days waiting: presets and a custom range", () => {
    expect(matchesBoardRow(row({ day: 7 }), parsePaymentFilters({ days: "0-7" }))).toBe(true);
    expect(matchesBoardRow(row({ day: 8 }), parsePaymentFilters({ days: "0-7" }))).toBe(false);
    expect(matchesBoardRow(row({ day: 30 }), parsePaymentFilters({ days: "8-30" }))).toBe(true);
    expect(matchesBoardRow(row({ day: 31 }), parsePaymentFilters({ days: "31-" }))).toBe(true);
    expect(matchesBoardRow(row({ day: 30 }), parsePaymentFilters({ days: "31-" }))).toBe(false);
    const custom = parsePaymentFilters({ days: "custom", dmin: "10", dmax: "12" });
    expect(custom.days).toEqual({ min: 10, max: 12 });
    expect(matchesBoardRow(row({ day: 11 }), custom)).toBe(true);
    expect(matchesBoardRow(row({ day: 13 }), custom)).toBe(false);
    expect(parsePaymentFilters({ days: "custom", dmin: "x" }).days).toEqual({ min: null, max: null });
  });

  test("vendors and deputies: any of the chosen", () => {
    const f = parsePaymentFilters({ vendor: ["v1", "v2"], deputy: "d2" });
    expect(matchesBoardRow(row({ vendorId: "v2", payeeUserId: "d2" }), f)).toBe(true);
    expect(matchesBoardRow(row({ vendorId: "v3", payeeUserId: "d2" }), f)).toBe(false);
    expect(matchesBoardRow(row({ vendorId: "v1", payeeUserId: "d1" }), f)).toBe(false);
    expect(activePaymentFilters(f)).toBe(2);
  });

  test("invoice date range, in agency days, inclusive", () => {
    const f = parsePaymentFilters({ from: "2026-11-10", to: "2026-11-12" });
    expect(matchesBoardRow(row({ issuedAt: new Date("2026-11-10T06:30:00Z") }), f)).toBe(true);
    expect(matchesBoardRow(row({ issuedAt: new Date("2026-11-13T05:30:00Z") }), f)).toBe(true);
    expect(matchesBoardRow(row({ issuedAt: new Date("2026-11-13T06:30:00Z") }), f)).toBe(false);
    expect(parsePaymentFilters({ from: "not a date" }).from).toBeNull();
  });

  test("amount range in dollars", () => {
    const f = parsePaymentFilters({ amin: "200", amax: "$300.50" });
    expect(f).toMatchObject({ amountMin: 20000, amountMax: 30050 });
    expect(matchesBoardRow(row({ totalCents: 28000 }), f)).toBe(true);
    expect(matchesBoardRow(row({ totalCents: 30051 }), f)).toBe(false);
    expect(matchesBoardRow(row({ totalCents: 19999 }), f)).toBe(false);
  });

  test("sent or unsent", () => {
    expect(matchesBoardRow(row({ sent: false }), parsePaymentFilters({ sent: "sent" }))).toBe(false);
    expect(matchesBoardRow(row({ sent: false }), parsePaymentFilters({ sent: "unsent" }))).toBe(true);
    expect(matchesBoardRow(row({ sent: true }), parsePaymentFilters({ sent: "unsent" }))).toBe(false);
    expect(parsePaymentFilters({ sent: "maybe" }).sent).toBeNull();
  });
});
