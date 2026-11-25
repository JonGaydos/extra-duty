import { describe, expect, test } from "vitest";
import { outsideRange, rateDollars, rateRangeMessage } from "@/domain/jobs/rate";

describe("agency rate range", () => {
  test("dollars drop whole cents and keep the rest", () => {
    expect(rateDollars(7000)).toBe("$70");
    expect(rateDollars(7250)).toBe("$72.50");
    expect(rateDollars(150000)).toBe("$1,500");
  });

  test("a rate on either edge is inside; open sides never refuse", () => {
    const r = { rateMinCents: 5000, rateMaxCents: 9000 };
    expect([4999, 5000, 9000, 9001].map((c) => outsideRange(c, r))).toEqual([true, false, false, true]);
    expect(outsideRange(1, { rateMinCents: null, rateMaxCents: null })).toBe(false);
    expect(outsideRange(99999, { rateMinCents: 5000, rateMaxCents: null })).toBe(false);
  });

  test("the message names both sides, or only the side that is set", () => {
    expect(rateRangeMessage({ rateMinCents: 5000, rateMaxCents: 9000 })).toBe("Rate must be between $50 and $90 an hour");
    expect(rateRangeMessage({ rateMinCents: 5000, rateMaxCents: null })).toBe("Rate must be at least $50 an hour");
    expect(rateRangeMessage({ rateMinCents: null, rateMaxCents: 9050 })).toBe("Rate must be at most $90.50 an hour");
  });
});
