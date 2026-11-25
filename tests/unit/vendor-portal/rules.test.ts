import { describe, expect, test } from "vitest";
import { lateCancelMinutes, vendorEditAllowed } from "@/domain/vendor-portal/rules";

const HOUR = 3_600_000;
const now = new Date("2035-06-01T12:00:00Z");
const s = { vendorEditLockHours: 24, vendorEditsAfterSignup: "none" as const, vendorCancelUntilHours: 2 };
const job = (hoursAhead: number, signedUpCount = 0) => ({ startAt: new Date(now.getTime() + hoursAhead * HOUR), signedUpCount });

describe("vendorEditAllowed", () => {
  test("with defaults any change within 24 hours of start is refused", () => {
    for (const change of ["time", "date", "headcount_up", "headcount_down", "description"] as const) {
      const r = vendorEditAllowed({ now, job: job(23), change, s });
      expect(r.allowed).toBe(false);
      expect(r.reason).toMatch(/24 hours/);
    }
  });

  test("time, date and headcount changes need approval; a description change does not", () => {
    expect(vendorEditAllowed({ now, job: job(48), change: "time", s })).toEqual({ allowed: true, needsApproval: true });
    expect(vendorEditAllowed({ now, job: job(48), change: "date", s })).toEqual({ allowed: true, needsApproval: true });
    expect(vendorEditAllowed({ now, job: job(48), change: "headcount_up", s })).toEqual({ allowed: true, needsApproval: true });
    expect(vendorEditAllowed({ now, job: job(48), change: "headcount_down", s })).toEqual({ allowed: true, needsApproval: true });
    expect(vendorEditAllowed({ now, job: job(48), change: "description", s })).toEqual({ allowed: true, needsApproval: false });
  });

  test("headcount down is refused once someone is signed up when edits after sign-up are none", () => {
    const r = vendorEditAllowed({ now, job: job(48, 1), change: "headcount_down", s });
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/signed up/);
    expect(vendorEditAllowed({ now, job: job(48, 0), change: "headcount_down", s }).allowed).toBe(true);
  });

  test("add_positions allows only more headcount once someone is signed up", () => {
    const open = { ...s, vendorEditsAfterSignup: "add_positions" as const };
    expect(vendorEditAllowed({ now, job: job(48, 2), change: "headcount_up", s: open })).toEqual({ allowed: true, needsApproval: true });
    expect(vendorEditAllowed({ now, job: job(48, 2), change: "headcount_down", s: open }).allowed).toBe(false);
    expect(vendorEditAllowed({ now, job: job(48, 2), change: "time", s: open }).allowed).toBe(false);
    expect(vendorEditAllowed({ now, job: job(48, 2), change: "description", s: open }).allowed).toBe(false);
  });

  test("with edits after sign-up none, every change is refused once someone is signed up", () => {
    for (const change of ["time", "date", "headcount_up", "headcount_down", "description"] as const) {
      expect(vendorEditAllowed({ now, job: job(48, 1), change, s }).allowed).toBe(false);
    }
    expect(vendorEditAllowed({ now, job: job(48, 0), change: "description", s })).toEqual({ allowed: true, needsApproval: false });
  });

  test("cancel is allowed until vendorCancelUntilHours before start and never at or after start", () => {
    expect(vendorEditAllowed({ now, job: job(23), change: "cancel", s })).toEqual({ allowed: true, needsApproval: false });
    expect(vendorEditAllowed({ now, job: job(2), change: "cancel", s }).allowed).toBe(true);
    expect(vendorEditAllowed({ now, job: job(1), change: "cancel", s }).allowed).toBe(false);
    expect(vendorEditAllowed({ now, job: job(0), change: "cancel", s: { ...s, vendorCancelUntilHours: 0 } }).allowed).toBe(false);
    expect(vendorEditAllowed({ now, job: job(-1), change: "cancel", s: { ...s, vendorCancelUntilHours: 0 } }).allowed).toBe(false);
  });
});

describe("lateCancelMinutes", () => {
  const span = { startAt: new Date("2035-06-10T22:00:00Z"), endAt: new Date("2035-06-11T04:00:00Z") };
  test("minimum basis gives the resolved minimum, scheduled basis the scheduled minutes", () => {
    expect(lateCancelMinutes(span, { lateCancelPayBasis: "minimum", minimumBillableMinutes: 240, hourRoundingMinutes: 15 })).toBe(240);
    expect(lateCancelMinutes(span, { lateCancelPayBasis: "scheduled", minimumBillableMinutes: 240, hourRoundingMinutes: 15 })).toBe(360);
  });
});
