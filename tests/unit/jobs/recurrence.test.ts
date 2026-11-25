import { describe, expect, it, test } from "vitest";
import { ValidationError } from "@/domain/errors";
import { expandDates, expandRecurrence, expandSelection, previewBulk, type DateSelection } from "@/domain/jobs/recurrence";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";

const settings = { releaseDayOfMonth: 15, releaseTime: "16:00" };
const first = { startAt: agencyInstant(2026, 10, 25, 7, 30), endAt: agencyInstant(2026, 10, 25, 12, 0) };
const hm = (d: Date) => {
  const p = agencyDateParts(d);
  return [p.month, p.day, p.hour, p.minute];
};

describe("expandRecurrence", () => {
  it("weekly Sundays keep 7:30 local across the Nov 1 DST change", () => {
    const out = expandRecurrence(first, { kind: "weekly", every: 1, weekdays: [0], end: { count: 3 } });
    expect(out.map((o) => hm(o.startAt))).toEqual([
      [10, 25, 7, 30],
      [11, 1, 7, 30],
      [11, 8, 7, 30],
    ]);
    expect(out.map((o) => hm(o.endAt))).toEqual([
      [10, 25, 12, 0],
      [11, 1, 12, 0],
      [11, 8, 12, 0],
    ]);
  });

  it("until is inclusive of that date", () => {
    const out = expandRecurrence(first, { kind: "weekly", every: 1, weekdays: [0], end: { until: agencyInstant(2026, 11, 8, 0, 0) } });
    expect(out).toHaveLength(3);
    const day = expandRecurrence(first, { kind: "daily", every: 2, end: { until: agencyInstant(2026, 10, 29, 23, 0) } });
    expect(day.map((o) => agencyDateParts(o.startAt).day)).toEqual([25, 27, 29]);
  });

  it("monthly uses the day of month and clamps short months", () => {
    const out = expandRecurrence(first, { kind: "monthly", every: 1, dayOfMonth: 31, end: { count: 4 } });
    expect(out.map((o) => [agencyDateParts(o.startAt).month, agencyDateParts(o.startAt).day])).toEqual([
      [10, 31],
      [11, 30],
      [12, 31],
      [1, 31],
    ]);
  });

  it("rejects more than 366 occurrences and bad input", () => {
    expect(() => expandRecurrence(first, { kind: "daily", every: 1, end: { count: 367 } })).toThrow(ValidationError);
    expect(() => expandRecurrence(first, { kind: "daily", every: 1, end: { until: agencyInstant(2030, 1, 1, 0, 0) } })).toThrow(ValidationError);
    expect(() => expandRecurrence(first, { kind: "daily", every: 0, end: { count: 2 } })).toThrow(ValidationError);
    expect(() => expandRecurrence(first, { kind: "weekly", every: 1, weekdays: [], end: { count: 2 } })).toThrow(ValidationError);
  });
});

describe("expandDates", () => {
  it("a range is inclusive and can filter by weekday", () => {
    const range = { kind: "range" as const, from: "2026-12-15", to: "2026-12-31" };
    expect(expandDates(range, "2026-12-15")).toHaveLength(17);
    expect(expandDates({ ...range, weekdays: [0, 6] }, "2026-12-15")).toEqual(["2026-12-19", "2026-12-20", "2026-12-26", "2026-12-27"]);
  });

  it("specific dates are sorted and de-duplicated", () => {
    const dates = ["2026-12-30", "2026-12-01", "2026-12-12", "2026-12-19", "2026-12-20", "2026-12-21", "2026-12-12"];
    expect(expandDates({ kind: "dates", dates }, "2026-12-01")).toEqual(["2026-12-01", "2026-12-12", "2026-12-19", "2026-12-20", "2026-12-21", "2026-12-30"]);
  });

  it("367 dates throws; bad keys throw", () => {
    const many = Array.from({ length: 367 }, (_, i) => new Date(Date.UTC(2027, 0, 1 + i)).toISOString().slice(0, 10));
    expect(() => expandDates({ kind: "dates", dates: many }, "2027-01-01")).toThrow(ValidationError);
    expect(expandDates({ kind: "dates", dates: many.slice(0, 366) }, "2027-01-01")).toHaveLength(366);
    expect(() => expandDates({ kind: "dates", dates: ["2026-02-30"] }, "2026-02-01")).toThrow(ValidationError);
    expect(() => expandDates({ kind: "range", from: "2026-12-31", to: "2026-12-01" }, "2026-12-01")).toThrow(ValidationError);
  });

  it("a pattern starts at the first date", () => {
    const out = expandDates({ kind: "pattern", recurrence: { kind: "weekly", every: 2, weekdays: [1, 3], end: { count: 4 } } }, "2026-12-02");
    expect(out).toEqual(["2026-12-02", "2026-12-14", "2026-12-16", "2026-12-28"]);
  });
});

describe("previewBulk", () => {
  it("an overnight detail on a DST day ends next morning and lasts 9 hours", () => {
    const input = { startAt: agencyInstant(2027, 3, 1, 20, 0), endAt: agencyInstant(2027, 3, 2, 6, 0) };
    const [p] = previewBulk(input, ["2027-03-13"], undefined, settings);
    expect(hm(p.startAt)).toEqual([3, 13, 20, 0]);
    expect(hm(p.endAt)).toEqual([3, 14, 6, 0]);
    expect((p.endAt.getTime() - p.startAt.getTime()) / 3_600_000).toBe(9);
    expect(p.releaseAt).toEqual(agencyInstant(2027, 2, 15, 16, 0));
  });

  it("an overnight detail across the fall-back change lasts 11 hours", () => {
    const input = { startAt: agencyInstant(2026, 10, 1, 20, 0), endAt: agencyInstant(2026, 10, 2, 6, 0) };
    const [p] = previewBulk(input, ["2026-10-31"], undefined, settings);
    expect(hm(p.endAt)).toEqual([11, 1, 6, 0]);
    expect((p.endAt.getTime() - p.startAt.getTime()) / 60_000).toBe(660);
  });

  it("an equal end time also crosses midnight; overrides change only their date", () => {
    const input = { startAt: agencyInstant(2027, 3, 1, 18, 0), endAt: agencyInstant(2027, 3, 1, 22, 0) };
    const out = previewBulk(input, ["2027-04-01", "2027-04-02"], { "2027-04-02": { startTime: "09:00", endTime: "09:00" } }, settings);
    expect(hm(out[0].startAt)).toEqual([4, 1, 18, 0]);
    expect(hm(out[0].endAt)).toEqual([4, 1, 22, 0]);
    expect(hm(out[1].startAt)).toEqual([4, 2, 9, 0]);
    expect(hm(out[1].endAt)).toEqual([4, 3, 9, 0]);
    expect(() => previewBulk(input, ["2027-04-01"], { "2027-04-01": { startTime: "9am" } }, settings)).toThrow(ValidationError);
  });
});

describe("expandSelection (the date picker's wire)", () => {
  test("a repeat that ends on a typed date reads the date as the end of that agency day", () => {
    const sel = { kind: "pattern", recurrence: { kind: "weekly", every: 1, weekdays: [6], end: { until: "2026-12-19" as unknown as Date } } } as DateSelection;
    expect(expandSelection(sel, "2026-12-05")).toEqual(["2026-12-05", "2026-12-12", "2026-12-19"]);
  });

  test("a repeat end that is not a date is refused", () => {
    const sel = { kind: "pattern", recurrence: { kind: "daily", every: 1, end: { until: "soon" as unknown as Date } } } as DateSelection;
    expect(() => expandSelection(sel, "2026-12-05")).toThrow("Choose the date the repeat ends.");
  });

  test("ranges and picked dates pass straight through", () => {
    expect(expandSelection({ kind: "range", from: "2026-12-05", to: "2026-12-07" }, "2026-12-05")).toEqual(["2026-12-05", "2026-12-06", "2026-12-07"]);
  });
});
