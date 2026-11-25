import { describe, expect, it } from "vitest";
import {
  billableMinutes,
  hoursChanged,
  invoiceTotal,
  lateCancelMinutes,
  resolveMinimum,
  reviewDecision,
  roundMinutes,
} from "@/domain/billing/rules";
import { ValidationError } from "@/domain/errors";

const s = { minimumBillableMinutes: 240, hourRoundingMinutes: 15 };
const at = (h: number) => new Date(Date.UTC(2026, 0, 10, h, 0));

describe("billing rules", () => {
  it("totals", () => {
    expect(invoiceTotal(360, 7500)).toBe(45000);
    expect(invoiceTotal(270, 5000)).toBe(22500);
    expect(invoiceTotal(390, 7500)).toBe(48750);
  });
  it("rounds up", () => {
    expect(roundMinutes(360, 15)).toBe(360);
    expect(roundMinutes(361, 15)).toBe(375);
    expect(roundMinutes(367, 15)).toBe(375);
  });
  it("applies minimum after rounding", () => {
    expect(billableMinutes(150, s)).toBe(240);
    expect(billableMinutes(300, s)).toBe(300);
    expect(billableMinutes(241, s)).toBe(255);
  });
  it("resolves minimum", () => {
    expect(resolveMinimum(180, 120, 240)).toBe(180);
    expect(resolveMinimum(null, 120, 240)).toBe(120);
    expect(resolveMinimum(null, null, 240)).toBe(240);
  });
  it("review decision", () => {
    expect(reviewDecision("changed_hours_only", false)).toBe("send");
    expect(reviewDecision("changed_hours_only", true)).toBe("hold");
    expect(reviewDecision("all", false)).toBe("hold");
    expect(reviewDecision("immediate", true)).toBe("send");
  });
  it("hoursChanged compares instants", () => {
    const a = { startAt: at(8), endAt: at(14) };
    expect(hoursChanged(a, { startAt: new Date(at(8).getTime()), endAt: new Date(at(14).getTime()) })).toBe(false);
    expect(hoursChanged(a, { startAt: at(8), endAt: at(15) })).toBe(true);
    expect(hoursChanged(a, { startAt: at(9), endAt: at(14) })).toBe(true);
  });
  it("late cancel minutes", () => {
    const six = { startAt: at(8), endAt: at(14) };
    const two = { startAt: at(8), endAt: at(10) };
    const base = { minimumBillableMinutes: 240, hourRoundingMinutes: 15 };
    expect(lateCancelMinutes(six, { ...base, lateCancelPayBasis: "minimum" })).toBe(240);
    expect(lateCancelMinutes(six, { ...base, lateCancelPayBasis: "scheduled" })).toBe(360);
    expect(lateCancelMinutes(two, { ...base, lateCancelPayBasis: "scheduled" })).toBe(240);
  });
  it("rejects invalid input", () => {
    expect(() => roundMinutes(-1, 15)).toThrow(ValidationError);
    expect(() => roundMinutes(10, 0)).toThrow(ValidationError);
    expect(() => billableMinutes(-5, s)).toThrow(ValidationError);
    expect(() => invoiceTotal(60, -1)).toThrow(ValidationError);
    expect(() => invoiceTotal(-60, 100)).toThrow(ValidationError);
  });
});
