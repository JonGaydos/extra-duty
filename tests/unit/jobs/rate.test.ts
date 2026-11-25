import { describe, expect, it } from "vitest";
import { resolveRate } from "@/domain/jobs/rate";

describe("resolveRate", () => {
  it("uses the vendor default when the job has no rate", () => {
    expect(resolveRate(null, 7000, 6500)).toBe(7000);
  });
  it("falls back to the agency default", () => {
    expect(resolveRate(null, null, 6500)).toBe(6500);
  });
  it("prefers the job rate", () => {
    expect(resolveRate(8000, 7000, 6500)).toBe(8000);
  });
  it("keeps an explicit zero job rate so it can be rejected", () => {
    expect(resolveRate(0, 7000, 6500)).toBe(0);
  });
});
