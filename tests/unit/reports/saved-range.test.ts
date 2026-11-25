import { describe, expect, test } from "vitest";
import { savedDayRange } from "@/app/(app)/coordinate/reports/saved-range";
import { agencyDateOnly } from "@/domain/time/agency-time";

/** What a save stores: the page's agency days as instants, then JSON (as the saved_reports spec column holds it). */
const stored = (from: string, to: string) => JSON.parse(JSON.stringify({ from: agencyDateOnly(from, "start"), to: agencyDateOnly(to, "end") })) as { from: string; to: string };

describe("a saved report's period reopens as the same agency days", () => {
  test("round trip, including a month that ends after a time change", () => {
    for (const [from, to] of [["2026-11-01", "2026-11-30"], ["2026-03-01", "2026-03-31"], ["2026-01-01", "2026-12-31"]]) {
      expect(savedDayRange(stored(from, to))).toEqual({ from, to });
    }
  });

  test("saving again does not drift", () => {
    let r = { from: "2026-11-01", to: "2026-11-30" };
    for (let i = 0; i < 3; i++) r = savedDayRange(stored(r.from, r.to))!;
    expect(r).toEqual({ from: "2026-11-01", to: "2026-11-30" });
  });

  test("date-only values stay as they are; an open period is null", () => {
    expect(savedDayRange({ from: "2026-11-01", to: "2026-11-30" })).toEqual({ from: "2026-11-01", to: "2026-11-30" });
    expect(savedDayRange({})).toBeNull();
  });
});
