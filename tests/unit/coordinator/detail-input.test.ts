import { describe, expect, test } from "vitest";
import { overrideSpanOn, spanOn } from "@/app/(app)/coordinate/_coordinator/detail-input";

const iso = (d: Date) => d.toISOString();

describe("spanOn", () => {
  test("an end after the start is the same day", () => {
    const s = spanOn("2026-12-03", "09:00", "13:00");
    expect(iso(s.startAt)).toBe("2026-12-03T15:00:00.000Z");
    expect(iso(s.endAt)).toBe("2026-12-03T19:00:00.000Z");
  });

  test("an end before the start ends the next day", () => {
    const s = spanOn("2026-12-03", "22:00", "06:00");
    expect(iso(s.endAt)).toBe("2026-12-04T12:00:00.000Z");
  });

  test("equal times are a 24-hour detail", () => {
    const s = spanOn("2026-12-03", "00:00", "00:00");
    expect(iso(s.startAt)).toBe("2026-12-03T06:00:00.000Z");
    expect(s.endAt.getTime() - s.startAt.getTime()).toBe(24 * 60 * 60 * 1000);
  });
});

describe("overrideSpanOn (bulk dates preview)", () => {
  test("refuses equal start and end times", () => {
    expect(() => overrideSpanOn("2026-12-03", "08:00", "08:00")).toThrow("The end time must differ from the start time.");
  });

  test("otherwise matches spanOn", () => {
    expect(overrideSpanOn("2026-12-03", "22:00", "06:00")).toEqual(spanOn("2026-12-03", "22:00", "06:00"));
  });
});
