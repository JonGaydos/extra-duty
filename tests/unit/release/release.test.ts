import { describe, expect, it } from "vitest";
import { agencyInstant } from "@/domain/time/agency-time";
import { isReleased, releaseAt, restoredReleaseAt } from "@/domain/release/release";

const s = { releaseDayOfMonth: 15, releaseTime: "16:00" };

describe("releaseAt", () => {
  it("December details release Nov 15 at 4 PM Central", () => {
    expect(releaseAt(agencyInstant(2026, 12, 5, 8, 0), s)).toEqual(agencyInstant(2026, 11, 15, 16, 0));
  });
  it("January details release in December of the previous year", () => {
    expect(releaseAt(agencyInstant(2027, 1, 9, 8, 0), s)).toEqual(agencyInstant(2026, 12, 15, 16, 0));
  });
  it("clamps day 31 to the last day of a 30-day month", () => {
    expect(releaseAt(agencyInstant(2026, 12, 1, 8, 0), { ...s, releaseDayOfMonth: 31 })).toEqual(
      agencyInstant(2026, 11, 30, 16, 0),
    );
  });
  it("clamps into February", () => {
    expect(releaseAt(agencyInstant(2027, 3, 10, 8, 0), { ...s, releaseDayOfMonth: 30 })).toEqual(
      agencyInstant(2027, 2, 28, 16, 0),
    );
  });
  it("clamps into February of a leap year", () => {
    expect(releaseAt(agencyInstant(2028, 3, 10, 8, 0), { ...s, releaseDayOfMonth: 30 })).toEqual(
      agencyInstant(2028, 2, 29, 16, 0),
    );
  });
  it("uses the agency month for a detail near a month boundary", () => {
    // 2026-12-01 00:30 CST is still December in agency time (06:30 UTC).
    expect(releaseAt(agencyInstant(2026, 12, 1, 0, 30), s)).toEqual(agencyInstant(2026, 11, 15, 16, 0));
  });
});

describe("isReleased", () => {
  it("a detail later this month is already released", () => {
    const job = { held: false, state: "active" as const, releaseAt: releaseAt(agencyInstant(2026, 11, 28, 8, 0), s) };
    expect(isReleased(job, agencyInstant(2026, 11, 22, 9, 0))).toBe(true);
  });
  it("is not released before the release instant and is released at it", () => {
    const at = agencyInstant(2026, 11, 15, 16, 0);
    const job = { held: false, state: "active" as const, releaseAt: at };
    expect(isReleased(job, new Date(at.getTime() - 1))).toBe(false);
    expect(isReleased(job, at)).toBe(true);
  });
  it("held jobs are never released", () => {
    expect(isReleased({ held: true, state: "active", releaseAt: new Date(0) }, new Date())).toBe(false);
  });
  it("approved (scheduled) jobs release by time alone; requests, canceled and declined never do", () => {
    for (const state of ["scheduled", "active"] as const) {
      expect(isReleased({ held: false, state, releaseAt: new Date(0) }, new Date())).toBe(true);
    }
    for (const state of ["requested", "canceled", "declined"] as const) {
      expect(isReleased({ held: false, state, releaseAt: new Date(0) }, new Date())).toBe(false);
    }
  });
  it("a job without a release time is not released", () => {
    expect(isReleased({ held: false, state: "scheduled", releaseAt: null }, new Date())).toBe(false);
  });
});

describe("releaseAt across the agency/UTC month boundary", () => {
  it("a detail on Nov 30 at 9 PM Central (December in UTC) releases Oct 15 at 4 PM", () => {
    expect(releaseAt(agencyInstant(2026, 11, 30, 21, 0), s)).toEqual(agencyInstant(2026, 10, 15, 16, 0));
  });
});

describe("restoredReleaseAt (a reactivated detail)", () => {
  const start = agencyInstant(2026, 12, 5, 8, 0);
  const normal = agencyInstant(2026, 11, 15, 16, 0);
  it("keeps a release that already happened, even an early Release now", () => {
    const early = agencyInstant(2026, 11, 2, 9, 0);
    expect(restoredReleaseAt({ startAt: start, releaseAt: early }, s, agencyInstant(2026, 11, 20, 9, 0))).toEqual(early);
  });
  it("is released when the normal release time has passed while it was canceled", () => {
    const now = agencyInstant(2026, 11, 20, 9, 0);
    expect(restoredReleaseAt({ startAt: start, releaseAt: null }, s, now)).toEqual(normal);
    expect(isReleased({ held: false, state: "scheduled", releaseAt: restoredReleaseAt({ startAt: start, releaseAt: null }, s, now) }, now)).toBe(true);
  });
  it("waits for the release time as configured now when it has not come", () => {
    const now = agencyInstant(2026, 11, 1, 9, 0);
    const stale = agencyInstant(2026, 11, 10, 16, 0);
    expect(restoredReleaseAt({ startAt: start, releaseAt: stale }, s, now)).toEqual(normal);
  });
});
