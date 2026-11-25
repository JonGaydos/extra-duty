import { describe, expect, test } from "vitest";
import { quietHoursEnd } from "@/domain/notifications/prefs";
import { agencyInstant } from "@/domain/time/agency-time";

const overnight = { enabled: true, startTime: "22:00", endTime: "06:00" };
const day = { enabled: true, startTime: "13:00", endTime: "15:00" };

describe("quietHoursEnd", () => {
  test("late evening inside an overnight window ends at 06:00 the next morning", () => {
    expect(quietHoursEnd(overnight, agencyInstant(2026, 11, 10, 23, 30))).toEqual(agencyInstant(2026, 11, 11, 6, 0));
  });
  test("early morning inside an overnight window ends at 06:00 the same day", () => {
    expect(quietHoursEnd(overnight, agencyInstant(2026, 11, 11, 5, 59))).toEqual(agencyInstant(2026, 11, 11, 6, 0));
  });
  test("the start is inside and the end is outside", () => {
    expect(quietHoursEnd(overnight, agencyInstant(2026, 11, 10, 22, 0))).not.toBeNull();
    expect(quietHoursEnd(overnight, agencyInstant(2026, 11, 11, 6, 0))).toBeNull();
  });
  test("a same-day window", () => {
    expect(quietHoursEnd(day, agencyInstant(2026, 11, 10, 14, 0))).toEqual(agencyInstant(2026, 11, 10, 15, 0));
    expect(quietHoursEnd(day, agencyInstant(2026, 11, 10, 15, 0))).toBeNull();
  });
  test("disabled or missing quiet hours never hold", () => {
    expect(quietHoursEnd({ ...overnight, enabled: false }, agencyInstant(2026, 11, 10, 23, 0))).toBeNull();
    expect(quietHoursEnd(undefined, agencyInstant(2026, 11, 10, 23, 0))).toBeNull();
  });
  test("month end rolls to the next month", () => {
    expect(quietHoursEnd(overnight, agencyInstant(2026, 11, 30, 23, 0))).toEqual(agencyInstant(2026, 12, 1, 6, 0));
  });
});
