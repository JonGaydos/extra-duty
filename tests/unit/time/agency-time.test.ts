import { describe, expect, it } from "vitest";
import {
  agencyDateParts,
  agencyDayKey,
  agencyInstant,
  agencyMonthKey,
  agencyWeekKey,
  minutesBetween,
} from "@/domain/time/agency-time";

describe("agency time", () => {
  it("fall-back overnight detail is 11 hours", () => {
    // DST ends Sunday 2026-11-01 at 02:00, so the night of Oct 31 to Nov 1 spans the change.
    const s = agencyInstant(2026, 10, 31, 20, 0);
    const e = agencyInstant(2026, 11, 1, 6, 0);
    expect(minutesBetween(s, e)).toBe(660);
  });

  it("the night after the fall-back date is a plain 10 hours", () => {
    const s = agencyInstant(2026, 11, 1, 20, 0);
    const e = agencyInstant(2026, 11, 2, 6, 0);
    expect(minutesBetween(s, e)).toBe(600);
  });

  it("spring-forward day has 23 hours", () => {
    expect(
      minutesBetween(agencyInstant(2027, 3, 14, 0, 0), agencyInstant(2027, 3, 15, 0, 0)),
    ).toBe(1380);
  });

  it("week key respects week start", () => {
    const thu = agencyInstant(2026, 11, 26, 12, 0);
    expect(agencyWeekKey(thu, 0)).toBe("2026-11-22");
    expect(agencyWeekKey(thu, 1)).toBe("2026-11-23");
  });

  it("round-trips parts and uses agency day, not UTC day", () => {
    const at = agencyInstant(2026, 7, 4, 22, 30); // 03:30 UTC on Jul 5
    expect(agencyDateParts(at)).toEqual({ year: 2026, month: 7, day: 4, hour: 22, minute: 30 });
    expect(agencyDayKey(at)).toBe("2026-07-04");
    expect(agencyMonthKey(at)).toBe("2026-07");
  });

  it("week key crosses month and year boundaries", () => {
    expect(agencyWeekKey(agencyInstant(2027, 1, 1, 9, 0), 0)).toBe("2026-12-27");
  });

  it("nonexistent local time resolves forward past the gap", () => {
    const at = agencyInstant(2027, 3, 14, 2, 30);
    expect(agencyDateParts(at)).toMatchObject({ day: 14, hour: 3, minute: 30 });
  });

  it("ambiguous local time resolves to the first (daylight) occurrence", () => {
    const at = agencyInstant(2026, 11, 1, 1, 30);
    expect(at.toISOString()).toBe("2026-11-01T06:30:00.000Z");
  });
});
