import { describe, expect, test } from "vitest";
import { laterLocalInput } from "../e2e/clock";
import { issueWaitingSince } from "../e2e/coordinator-fixtures";
import { daysWaiting } from "@/domain/coordinator/views";
import { agencyInstant } from "@/domain/time/agency-time";

/** The e2e fixtures must not depend on the hour the suite runs. These pin the clock at the hours that broke them. */
describe("e2e fixtures at hostile hours", () => {
  test("adding minutes to a datetime-local value crosses midnight into the next day", () => {
    expect(laterLocalInput("2026-11-23T23:45", 40)).toBe("2026-11-24T00:25");
    expect(laterLocalInput("2026-12-31T23:30", 40)).toBe("2027-01-01T00:10");
    expect(laterLocalInput("2026-11-23T10:00", 40)).toBe("2026-11-23T10:40");
  });

  test("the coordinator's payment issue has waited 10 days at any hour of the agency day", () => {
    for (const [h, m] of [[0, 5], [2, 0], [8, 59], [9, 1], [12, 0], [23, 55]]) {
      const now = agencyInstant(2026, 11, 24, h, m);
      expect(daysWaiting(issueWaitingSince(now), now), `at ${h}:${m}`).toBe(10);
    }
  });
});
