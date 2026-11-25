import { describe, expect, test } from "vitest";
import { activityPeriods } from "@/domain/reports/periods";
import { agencyInstant } from "@/domain/time/agency-time";

const summer = { name: "Summer", startMonthDay: "05-15", endMonthDay: "09-15" };
const winter = { name: "Winter", startMonthDay: "11-01", endMonthDay: "02-28" };

describe("activity report periods (agency days)", () => {
  test("this month and this year", () => {
    const p = activityPeriods(agencyInstant(2026, 2, 10, 12, 0), []);
    expect(p.month).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(p.year).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(p.season).toBeNull();
  });

  test("an agency late evening on the last day of a month is still that month", () => {
    const p = activityPeriods(agencyInstant(2026, 11, 30, 23, 30), []);
    expect(p.month).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });

  test("the season covering today, inside one year", () => {
    const p = activityPeriods(agencyInstant(2026, 7, 4, 12, 0), [winter, summer]);
    expect(p.season).toEqual({ name: "Summer", from: "2026-05-15", to: "2026-09-15" });
  });

  test("a season that wraps the year end, seen from either side", () => {
    expect(activityPeriods(agencyInstant(2026, 12, 20, 12, 0), [summer, winter]).season).toEqual({ name: "Winter", from: "2026-11-01", to: "2027-02-28" });
    expect(activityPeriods(agencyInstant(2027, 1, 20, 12, 0), [summer, winter]).season).toEqual({ name: "Winter", from: "2026-11-01", to: "2027-02-28" });
  });
});
