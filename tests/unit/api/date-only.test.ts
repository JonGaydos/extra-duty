import { describe, expect, test } from "vitest";
import { agencyDate } from "@/lib/api/dates";
import { routes } from "@/lib/api/registry";

describe("date-only API inputs are agency days", () => {
  test("a date-only value is agency midnight, or the end of that agency day, across both DST changes", () => {
    const start = agencyDate("start");
    const end = agencyDate("end");
    // Spring forward: 2026-03-08 starts in CST (UTC-6) and ends in CDT (UTC-5).
    expect(start.parse("2026-03-08").toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(end.parse("2026-03-08").toISOString()).toBe("2026-03-09T04:59:59.999Z");
    // Fall back: 2026-11-01 starts in CDT and ends in CST.
    expect(start.parse("2026-11-01").toISOString()).toBe("2026-11-01T05:00:00.000Z");
    expect(end.parse("2026-11-01").toISOString()).toBe("2026-11-02T05:59:59.999Z");
  });

  test("a full timestamp is kept as sent; anything else is refused", () => {
    expect(agencyDate("start").parse("2026-03-08T12:00:00Z").toISOString()).toBe("2026-03-08T12:00:00.000Z");
    expect(agencyDate("start").safeParse("2026-02-30").success).toBe(false);
    expect(agencyDate("start").safeParse("soon").success).toBe(false);
  });

  test("the jobs list reads from and to as agency days", () => {
    const q = routes["GET /jobs"].query!.parse({ from: "2026-03-08", to: "2026-03-08" }) as { from: Date; to: Date };
    expect(q.from.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    expect(q.to.toISOString()).toBe("2026-03-09T04:59:59.999Z");
  });

  test("a suspension end is an agency day", () => {
    const s = routes["POST /users/{id}/suspension"].body!.parse({ reason: "x", until: "2026-03-08" }) as { until: Date };
    expect(s.until.toISOString()).toBe("2026-03-08T06:00:00.000Z");
    // Leaving `until` out (or null) suspends with no end date, as before the retrofit.
    expect(routes["POST /users/{id}/suspension"].body!.parse({ reason: "x" })).toMatchObject({ until: null });
    expect(routes["POST /users/{id}/suspension"].body!.parse({ reason: "x", until: null })).toMatchObject({ until: null });
  });
});

describe("instant fields (detail times, sign-up, billing, invoice edits)", () => {
  test("a date-only value is refused rather than read as UTC midnight; a full timestamp is kept", async () => {
    const { parseDate } = await import("@/app/api/v1/jobs/parse");
    expect(() => parseDate("2026-03-08", "Start time")).toThrow("Start time needs a date and time, such as 2026-03-08T17:00:00-06:00.");
    expect(parseDate("2026-03-08T17:00:00-06:00", "Start time").toISOString()).toBe("2026-03-08T23:00:00.000Z");
    expect(() => parseDate("soon", "End time")).toThrow("End time is not a valid date.");
  });
});
