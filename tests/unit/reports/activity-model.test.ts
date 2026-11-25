import { describe, expect, test } from "vitest";
import { activityRows, leaders, rangeText, sortRows } from "@/app/(app)/coordinate/reports/activity/model";

const result = {
  columns: ["deputy", "hours", "cancellations", "cancellation_rate"],
  rows: [
    ["Avery", 6, 4, 50],
    ["Blake", 1, 2, 66.7],
    ["Casey", 0, 0, null],
    ["Drew", 6, 1, 10],
  ],
  keys: [["a"], ["b"], ["c"], ["d"]],
  totals: {},
};

describe("activity report model", () => {
  const rows = activityRows(result);

  test("rows carry the person id and each measure by name", () => {
    expect(rows[0]).toEqual({ userId: "a", name: "Avery", values: { hours: 6, cancellations: 4, cancellation_rate: 50 } });
  });

  test("sorts by any column either way, ties by name, blanks last", () => {
    expect(sortRows(rows, "hours", "desc").map((r) => r.name)).toEqual(["Avery", "Drew", "Blake", "Casey"]);
    expect(sortRows(rows, "cancellation_rate", "asc").map((r) => r.name)).toEqual(["Drew", "Avery", "Blake", "Casey"]);
    expect(sortRows(rows, "cancellation_rate", "desc").map((r) => r.name)).toEqual(["Blake", "Avery", "Drew", "Casey"]);
    expect(sortRows(rows, "name", "desc").map((r) => r.name)).toEqual(["Drew", "Casey", "Blake", "Avery"]);
  });

  test("leaders are the top five above zero", () => {
    expect(leaders(rows, "cancellations").map((r) => r.name)).toEqual(["Avery", "Blake", "Drew"]);
    expect(leaders(rows, "hours", 2).map((r) => r.name)).toEqual(["Avery", "Drew"]);
  });
});

test("periods read as dates", () => {
  expect(rangeText({ from: "2026-11-01", to: "2026-11-30" })).toBe("Nov 1 to Nov 30, 2026");
  expect(rangeText({ from: "2026-11-01", to: "2027-02-28" })).toBe("Nov 1, 2026 to Feb 28, 2027");
});
