import { describe, expect, test } from "vitest";
import { addPosition, changePositionType, detailSummary } from "@/app/(app)/coordinate/_coordinator/detail-summary";

const rules = { minimumBillableMinutes: 0, hourRoundingMinutes: 15 };
const DS = "ds";
const IC = "ic";

describe("detailSummary", () => {
  test("a date whose times changed is priced on its own times", () => {
    const s = detailSummary({
      dates: ["2026-12-01", "2026-12-02"],
      startTime: "09:00",
      endTime: "13:00",
      overrides: { "2026-12-02": { endTime: "15:00" } },
      rateCents: 5000,
      positions: [{ positionTypeId: DS, count: 2, differentialCents: 0 }],
      rules,
    });
    expect(s.perDate.map((d) => d.perDeputy.map((p) => p.totalCents))).toEqual([[20000], [30000]]);
    // Low and high of what one deputy earns across the dates.
    expect(s.low).toEqual({ totalCents: 20000, rateCents: 5000 });
    expect(s.high).toEqual({ totalCents: 30000, rateCents: 5000 });
    // 2 deputies at $200 plus 2 at $300.
    expect(s.vendorTotalCents).toBe(100000);
  });

  test("an overnight override wraps to the next day", () => {
    const s = detailSummary({ dates: ["2026-12-01"], startTime: "09:00", endTime: "13:00", overrides: { "2026-12-01": { startTime: "22:00", endTime: "02:00" } }, rateCents: 6000, positions: [{ positionTypeId: DS, count: 1, differentialCents: 0 }], rules });
    expect(s.perDate[0].minutes).toBe(240);
    expect(s.vendorTotalCents).toBe(24000);
  });

  test("a position differential raises that position's rate on top of the base", () => {
    const s = detailSummary({
      dates: ["2026-12-01"],
      startTime: "09:00",
      endTime: "13:00",
      overrides: {},
      rateCents: 5000,
      positions: [
        { positionTypeId: DS, count: 3, differentialCents: 0 },
        { positionTypeId: IC, count: 1, differentialCents: 2500 },
      ],
      rules,
    });
    expect(s.low).toEqual({ totalCents: 20000, rateCents: 5000 });
    expect(s.high).toEqual({ totalCents: 30000, rateCents: 7500 });
    expect(s.vendorTotalCents).toBe(3 * 20000 + 30000);
  });

  test("each date carries its own pay range across positions", () => {
    const s = detailSummary({
      dates: ["2026-12-01", "2026-12-02"],
      startTime: "09:00",
      endTime: "13:00",
      overrides: { "2026-12-02": { endTime: "15:00" } },
      rateCents: 5000,
      positions: [
        { positionTypeId: DS, count: 2, differentialCents: 0 },
        { positionTypeId: IC, count: 1, differentialCents: 2500 },
      ],
      rules,
    });
    expect(s.perDate[1].low).toEqual({ totalCents: 30000, rateCents: 5000 });
    expect(s.perDate[1].high).toEqual({ totalCents: 45000, rateCents: 7500 });
  });

  test("with no dates chosen the usual times price one date", () => {
    const s = detailSummary({ dates: [], startTime: "09:00", endTime: "13:00", overrides: {}, rateCents: 5000, positions: [{ positionTypeId: DS, count: 1, differentialCents: 0 }], rules });
    expect(s.perDate).toHaveLength(1);
    expect(s.vendorTotalCents).toBe(20000);
  });

  test("the minimum applies per date", () => {
    const s = detailSummary({ dates: ["2026-12-01"], startTime: "09:00", endTime: "10:00", overrides: {}, rateCents: 6000, positions: [{ positionTypeId: DS, count: 1, differentialCents: 0 }], rules: { minimumBillableMinutes: 180, hourRoundingMinutes: 15 } });
    expect(s.vendorTotalCents).toBe(18000);
  });
});

describe("addPosition", () => {
  test("adds the agency default position type, not the next one in the list", () => {
    expect(addPosition([{ positionTypeId: IC, count: 1 }], DS)).toEqual([
      { positionTypeId: IC, count: 1 },
      { positionTypeId: DS, count: 1 },
    ]);
  });
  test("raises the count when the default is already listed", () => {
    expect(addPosition([{ positionTypeId: DS, count: 2 }, { positionTypeId: IC, count: 1 }], DS)).toEqual([
      { positionTypeId: DS, count: 3 },
      { positionTypeId: IC, count: 1 },
    ]);
  });
});

describe("changePositionType", () => {
  test("choosing a type already listed merges the rows and adds the counts", () => {
    expect(changePositionType([{ positionTypeId: DS, count: 2 }, { positionTypeId: IC, count: 1 }], 1, DS)).toEqual([{ positionTypeId: DS, count: 3 }]);
  });
  test("choosing a new type changes only that row", () => {
    expect(changePositionType([{ positionTypeId: DS, count: 2 }], 0, IC)).toEqual([{ positionTypeId: IC, count: 2 }]);
  });
});
