import { describe, expect, test } from "vitest";
import { parseWindow } from "@/app/api/v1/jobs/parse";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-23T15:00:00Z");

describe("parseWindow", () => {
  test("onlyWorkable defaults to the next 90 days", () => {
    const w = parseWindow(undefined, undefined, true, NOW);
    expect(w.from.getTime()).toBe(NOW);
    expect(w.to.getTime()).toBe(NOW + 90 * DAY);
  });

  test("onlyWorkable with a from more than 90 days ahead and no to still gets a window after from", () => {
    const from = new Date(NOW + 200 * DAY);
    const w = parseWindow(from, undefined, true, NOW);
    expect(w.to.getTime() - w.from.getTime()).toBe(90 * DAY);
  });

  test("an explicit to is kept; without onlyWorkable the window is open", () => {
    expect(parseWindow(new Date("2026-12-01T00:00:00Z"), new Date("2026-12-05T00:00:00Z"), true, NOW).to.toISOString()).toBe("2026-12-05T00:00:00.000Z");
    const open = parseWindow(undefined, undefined, false, NOW);
    expect(open.from.getTime()).toBe(0);
    expect(open.to.getUTCFullYear()).toBe(9999);
  });
});
