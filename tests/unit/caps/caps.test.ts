import { describe, expect, it } from "vitest";
import { evaluateCaps } from "@/domain/caps/caps";
import type { Season } from "@/domain/caps/seasons";
import { ValidationError } from "@/domain/errors";
import { agencyInstant } from "@/domain/time/agency-time";

const at = (m: number, d: number, h: number, min = 0) => agencyInstant(2026, m, d, h, min);

function season(over: Partial<Season> = {}): Season {
  return {
    id: "s1",
    name: "Summer",
    startMonthDay: "01-01",
    endMonthDay: "12-31",
    rollingCapMinutes: 960,
    weekCapMinutes: 1920,
    monthCapMinutes: 6000,
    ...over,
  } as Season;
}

const base = { weekStartsOn: 0, rollingWindowHours: 24 };
const rolling = (r: ReturnType<typeof evaluateCaps>) => r.find((x) => x.cap === "rolling")!;

describe("evaluateCaps rolling", () => {
  it("counts only worked minutes inside the window", () => {
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [{ startAt: at(7, 15, 6), endAt: at(7, 15, 12) }],
      candidate: { startAt: at(7, 15, 14), endAt: at(7, 15, 22) },
    });
    expect(rolling(r)).toMatchObject({ usedMinutes: 840, limitMinutes: 960, ok: true });
  });

  it("reaches exactly 960 and fails one minute over", () => {
    const existing = [{ startAt: at(7, 15, 6), endAt: at(7, 15, 12) }];
    const ok = evaluateCaps({
      ...base,
      seasons: [season()],
      existing,
      candidate: { startAt: at(7, 15, 20), endAt: at(7, 16, 6) },
    });
    expect(rolling(ok)).toMatchObject({ usedMinutes: 960, ok: true });
    const over = evaluateCaps({
      ...base,
      seasons: [season()],
      existing,
      candidate: { startAt: at(7, 15, 19, 59), endAt: at(7, 16, 6) },
    });
    expect(rolling(over)).toMatchObject({ usedMinutes: 961, ok: false });
  });

  it("counts an overnight detail and next-day detail within 24 hours", () => {
    const input = {
      ...base,
      existing: [{ startAt: at(7, 15, 20), endAt: at(7, 16, 6) }],
      candidate: { startAt: at(7, 16, 10), endAt: at(7, 16, 16) },
    };
    expect(rolling(evaluateCaps({ ...input, seasons: [season()] }))).toMatchObject({ usedMinutes: 960, ok: true });
    const tight = evaluateCaps({ ...input, seasons: [season({ rollingCapMinutes: 900 })] });
    expect(rolling(tight)).toMatchObject({ usedMinutes: 960, limitMinutes: 900, ok: false });
  });

  it("ignores a detail that ended 24 hours before the candidate starts", () => {
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [{ startAt: at(7, 14, 4), endAt: at(7, 14, 10) }],
      candidate: { startAt: at(7, 15, 10), endAt: at(7, 15, 14) },
    });
    expect(rolling(r).usedMinutes).toBe(240);
  });

  it("does not double count overlapping existing intervals", () => {
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [
        { startAt: at(7, 15, 6), endAt: at(7, 15, 10) },
        { startAt: at(7, 15, 8), endAt: at(7, 15, 12) },
      ],
      candidate: { startAt: at(7, 15, 14), endAt: at(7, 15, 16) },
    });
    expect(rolling(r).usedMinutes).toBe(480);
  });

  it("omits caps with no season or null limits", () => {
    expect(
      evaluateCaps({
        ...base,
        seasons: [],
        existing: [],
        candidate: { startAt: at(7, 15, 8), endAt: at(7, 15, 9) },
      }),
    ).toEqual([]);
    const r = evaluateCaps({
      ...base,
      seasons: [season({ rollingCapMinutes: null, weekCapMinutes: null })],
      existing: [],
      candidate: { startAt: at(7, 15, 8), endAt: at(7, 15, 9) },
    });
    expect(r.map((x) => x.cap)).toEqual(["month"]);
  });
});

describe("evaluateCaps week and month", () => {
  it("sums a calendar week (Sunday start) and flags overage", () => {
    // 2026-07-12 is a Sunday.
    const existing = [
      { startAt: at(7, 12, 8), endAt: at(7, 12, 16) },
      { startAt: at(7, 14, 8), endAt: at(7, 14, 16) },
    ];
    const r = evaluateCaps({
      ...base,
      seasons: [season({ weekCapMinutes: 1000 })],
      existing,
      candidate: { startAt: at(7, 16, 8), endAt: at(7, 16, 16) },
    });
    expect(r.filter((x) => x.cap === "week")).toEqual([
      { cap: "week", period: "2026-07-12", usedMinutes: 1440, limitMinutes: 1000, ok: false },
    ]);
  });

  it("excludes the previous week and splits a detail crossing a week boundary", () => {
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [{ startAt: at(7, 11, 8), endAt: at(7, 11, 16) }],
      candidate: { startAt: at(7, 11, 22), endAt: at(7, 12, 2) },
    });
    const weeks = r.filter((x) => x.cap === "week");
    expect(weeks.map((w) => [w.period, w.usedMinutes])).toEqual([
      ["2026-07-05", 480 + 120],
      ["2026-07-12", 120],
    ]);
  });

  it("counts a week spanning two months in both months separately", () => {
    // Week of Sun 2026-07-26 runs into August.
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [{ startAt: at(7, 31, 8), endAt: at(7, 31, 16) }],
      candidate: { startAt: at(7, 31, 22), endAt: at(8, 1, 2) },
    });
    expect(r.filter((x) => x.cap === "month").map((m) => [m.period, m.usedMinutes])).toEqual([
      ["2026-07", 480 + 120],
      ["2026-08", 120],
    ]);
    expect(r.filter((x) => x.cap === "week")).toEqual([
      { cap: "week", period: "2026-07-26", usedMinutes: 720, limitMinutes: 1920, ok: true },
    ]);
  });

  it("takes each period's limit from the season of its first day", () => {
    const seasons = [
      season({ id: "a", startMonthDay: "01-01", endMonthDay: "07-31", monthCapMinutes: 100 }),
      season({ id: "b", startMonthDay: "08-01", endMonthDay: "12-31", monthCapMinutes: 200 }),
    ];
    const r = evaluateCaps({
      ...base,
      seasons,
      existing: [],
      candidate: { startAt: at(7, 31, 22), endAt: at(8, 1, 2) },
    });
    expect(r.filter((x) => x.cap === "month").map((m) => [m.period, m.limitMinutes])).toEqual([
      ["2026-07", 100],
      ["2026-08", 200],
    ]);
  });
});

describe("evaluateCaps regressions", () => {
  it("evaluates a candidate inside a long back-to-back block (4 h window)", () => {
    const r = evaluateCaps({
      weekStartsOn: 0,
      rollingWindowHours: 4,
      seasons: [season({ rollingCapMinutes: 120 })],
      existing: [
        { startAt: at(7, 15, 6), endAt: at(7, 15, 12) },
        { startAt: at(7, 15, 14), endAt: at(7, 15, 20) },
      ],
      candidate: { startAt: at(7, 15, 12), endAt: at(7, 15, 14) },
    });
    expect(rolling(r)).toMatchObject({ usedMinutes: 240, limitMinutes: 120, ok: false });
  });

  it("evaluates a candidate inside a long back-to-back block (24 h window)", () => {
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [
        { startAt: at(7, 1, 0), endAt: at(7, 2, 8) },
        { startAt: at(7, 2, 16), endAt: at(7, 4, 0) },
      ],
      candidate: { startAt: at(7, 2, 8), endAt: at(7, 2, 16) },
    });
    expect(rolling(r)).toMatchObject({ usedMinutes: 1440, limitMinutes: 960, ok: false });
  });

  it("counts real elapsed minutes across the fall-back change", () => {
    // Nov 1 2026 is a Sunday; 20:00 Oct 31 to 06:00 Nov 1 is 11 real hours.
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [{ startAt: agencyInstant(2026, 10, 31, 20, 0), endAt: agencyInstant(2026, 11, 1, 6, 0) }],
      candidate: { startAt: agencyInstant(2026, 11, 1, 10, 0), endAt: agencyInstant(2026, 11, 1, 15, 0) },
    });
    expect(rolling(r)).toMatchObject({ usedMinutes: 960, ok: true });
    expect(r.filter((x) => x.cap === "week")).toEqual([
      { cap: "week", period: "2026-11-01", usedMinutes: 420 + 300, limitMinutes: 1920, ok: true },
    ]);
  });

  it("takes the week limit from the week's first day and rolling from the candidate's start", () => {
    const seasons = [
      season({ id: "a", startMonthDay: "01-01", endMonthDay: "07-31", weekCapMinutes: 100, rollingCapMinutes: 50 }),
      season({ id: "b", startMonthDay: "08-01", endMonthDay: "12-31", weekCapMinutes: 200, rollingCapMinutes: 70 }),
    ];
    // Week of Sun Jul 26 contains Aug 1 (Saturday).
    const r = evaluateCaps({
      ...base,
      seasons,
      existing: [],
      candidate: { startAt: at(8, 1, 8), endAt: at(8, 1, 10) },
    });
    expect(r.find((x) => x.cap === "week")).toMatchObject({ period: "2026-07-26", limitMinutes: 100 });
    expect(rolling(r).limitMinutes).toBe(70);
  });

  it("ignores a detail starting exactly one window after the candidate ends", () => {
    const r = evaluateCaps({
      ...base,
      seasons: [season()],
      existing: [{ startAt: at(7, 16, 10), endAt: at(7, 16, 14) }],
      candidate: { startAt: at(7, 15, 6), endAt: at(7, 15, 10) },
    });
    expect(rolling(r).usedMinutes).toBe(240);
  });

  it("rejects an empty or reversed candidate and a bad weekStartsOn", () => {
    const ok = { ...base, seasons: [season()], existing: [] };
    expect(() => evaluateCaps({ ...ok, candidate: { startAt: at(7, 15, 8), endAt: at(7, 15, 8) } })).toThrow(ValidationError);
    expect(() => evaluateCaps({ ...ok, candidate: { startAt: at(7, 15, 9), endAt: at(7, 15, 8) } })).toThrow(ValidationError);
    expect(() =>
      evaluateCaps({ ...ok, weekStartsOn: 7, candidate: { startAt: at(7, 15, 8), endAt: at(7, 15, 9) } }),
    ).toThrow(ValidationError);
  });
});
