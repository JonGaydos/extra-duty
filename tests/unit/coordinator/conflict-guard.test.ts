import { describe, expect, test } from "vitest";
import { conflictGuard } from "@/app/(app)/coordinate/_coordinator/conflict-guard";

const refused = { ok: false as const, error: "x", checks: [{ check: "overlap", message: "Riley on #12, Tue, Dec 8: Overlaps job #13" }, { check: "rank", message: "Requires the CSO rank" }], fields: { j1: "abcd" } };

describe("conflictGuard", () => {
  test("shows only the schedule conflicts of the last refusal, with their fingerprints", () => {
    const g = conflictGuard({ result: refused, dirty: false, confirmed: true, reason: "Agreed" });
    expect(g.conflicts).toEqual(["Riley on #12, Tue, Dec 8: Overlaps job #13"]);
    expect(g.override).toEqual({ reason: "Agreed", fingerprints: { j1: "abcd" } });
  });
  test("any change to the edit hides the old conflicts and drops the override", () => {
    const g = conflictGuard({ result: refused, dirty: true, confirmed: true, reason: "Agreed" });
    expect(g.conflicts).toEqual([]);
    expect(g.override).toBeNull();
  });
  test("no override without a confirmation and a reason", () => {
    expect(conflictGuard({ result: refused, dirty: false, confirmed: false, reason: "Agreed" }).override).toBeNull();
    expect(conflictGuard({ result: refused, dirty: false, confirmed: true, reason: "  " }).override).toBeNull();
  });
});

describe("clearsConflicts", () => {
  test("only changes that can alter the deputy conflicts clear a confirmed override", async () => {
    const { clearsConflicts } = await import("@/app/(app)/coordinate/_coordinator/conflict-guard");
    for (const k of ["startTime", "endTime", "flex", "date", "scope"]) expect(clearsConflicts(k)).toBe(true);
    for (const k of ["rate", "rateOverrideReason", "title", "description", "positions", "contactName"]) expect(clearsConflicts(k)).toBe(false);
  });
});
