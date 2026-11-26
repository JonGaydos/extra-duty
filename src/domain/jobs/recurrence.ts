import { ValidationError } from "../errors";
import { releaseAt, type ReleaseSettings } from "../release/release";
import { agencyDateOnly, agencyDateParts, agencyDayKey, agencyInstant } from "../time/agency-time";
import type { JobInput } from "./jobs";
import { byText } from "@/lib/sort";

export const MAX_BULK_DATES = 366;

export type Recurrence =
  | { kind: "daily"; every: number; end: RecurrenceEnd }
  | { kind: "weekly"; every: number; weekdays: number[]; end: RecurrenceEnd }
  | { kind: "monthly"; every: number; dayOfMonth: number; end: RecurrenceEnd };
type RecurrenceEnd = { count: number } | { until: Date };

/** Dates are agency `YYYY-MM-DD` keys; weekdays are 0 (Sunday) to 6 (Saturday). */
export type DateSelection =
  | { kind: "range"; from: string; to: string; weekdays?: number[] }
  | { kind: "dates"; dates: string[] }
  | { kind: "pattern"; recurrence: Recurrence };

export type TimeOverrides = Record<string, { startTime?: string; endTime?: string }>;
export type BulkPreview = { date: string; startAt: Date; endAt: Date; releaseAt: Date };

const DAY_MS = 86_400_000;
const pad = (n: number, width = 2) => String(n).padStart(width, "0");

type Ymd = { y: number; m: number; d: number };

function parseKey(key: string): Ymd {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key ?? "");
  if (!match) throw new ValidationError(`"${key}" is not a valid date (use YYYY-MM-DD).`);
  const out = { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  const probe = new Date(Date.UTC(out.y, out.m - 1, out.d));
  if (probe.getUTCFullYear() !== out.y || probe.getUTCMonth() !== out.m - 1 || probe.getUTCDate() !== out.d) {
    throw new ValidationError(`"${key}" is not a valid date.`);
  }
  return out;
}

const toKey = (y: number, m: number, d: number) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
const utcOf = (key: string) => {
  const p = parseKey(key);
  return Date.UTC(p.y, p.m - 1, p.d);
};
function keyOfUtc(ms: number): string {
  const d = new Date(ms);
  return toKey(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}
export const addDays = (key: string, n: number) => keyOfUtc(utcOf(key) + n * DAY_MS);
const weekdayOf = (key: string) => new Date(utcOf(key)).getUTCDay();
const dayDiff = (a: string, b: string) => Math.round((utcOf(b) - utcOf(a)) / DAY_MS);

function parseTime(t: string): { h: number; m: number } {
  const match = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(t ?? "");
  if (!match) throw new ValidationError(`"${t}" is not a valid time (use HH:MM).`);
  return { h: Number(match[1]), m: Number(match[2]) };
}

function instantOn(date: string, h: number, m: number): Date {
  const p = parseKey(date);
  return agencyInstant(p.y, p.m, p.d, h, m);
}

function assertWeekdays(w: number[]): void {
  if (w.length === 0 || w.some((n) => !Number.isInteger(n) || n < 0 || n > 6)) {
    throw new ValidationError("Weekdays must be numbers from 0 (Sunday) to 6 (Saturday).");
  }
}

/** How a series ends: after `limitCount` dates, or on `untilKey` (an agency date key). */
function seriesEnd(end: RecurrenceEnd): { limitCount: number; untilKey: string | null } {
  if ("count" in end) {
    if (!Number.isInteger(end.count) || end.count < 1) throw new ValidationError("The number of occurrences must be at least 1.");
    if (end.count > MAX_BULK_DATES) throw new ValidationError(`A series can hold at most ${MAX_BULK_DATES} dates.`);
    return { limitCount: end.count, untilKey: null };
  }
  if (!(end.until instanceof Date) || Number.isNaN(end.until.getTime())) throw new ValidationError("An end date is required.");
  return { limitCount: MAX_BULK_DATES, untilKey: agencyDayKey(end.until) };
}

/** Adds a date; false once the series is complete (past `until`, or the count reached). */
type Push = (key: string) => boolean;

function weeklyDates(firstDate: string, r: Extract<Recurrence, { kind: "weekly" }>, untilKey: string | null, push: Push): void {
  assertWeekdays(r.weekdays);
  const days = [...new Set(r.weekdays)].sort((a, b) => a - b);
  const weekStart = addDays(firstDate, -weekdayOf(firstDate));
  for (let w = 0; ; w++) {
    // A week with no day left before `until` ends the loop.
    if (untilKey !== null && addDays(weekStart, w * r.every * 7) > untilKey) return;
    for (const wd of days) {
      const key = addDays(weekStart, w * r.every * 7 + wd);
      if (key < firstDate) continue;
      if (!push(key)) return;
    }
  }
}

function monthlyDates(firstDate: string, r: Extract<Recurrence, { kind: "monthly" }>, untilKey: string | null, push: Push): void {
  if (!Number.isInteger(r.dayOfMonth) || r.dayOfMonth < 1 || r.dayOfMonth > 31) throw new ValidationError("The day of the month must be from 1 to 31.");
  const first = parseKey(firstDate);
  for (let i = 0; ; i++) {
    const idx = first.y * 12 + (first.m - 1) + i * r.every;
    const y = Math.floor(idx / 12);
    const m = (idx % 12) + 1;
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const key = toKey(y, m, Math.min(r.dayOfMonth, last));
    if (key < firstDate) continue;
    if (untilKey !== null && key > untilKey) return;
    if (!push(key)) return;
  }
}

/** Occurrence dates for a pattern, starting from `firstDate`. Monthly days past a short month's end fall on its last day. */
function recurrenceDates(firstDate: string, r: Recurrence): string[] {
  if (!Number.isInteger(r.every) || r.every < 1) throw new ValidationError("A repeat interval must be a whole number of at least 1.");
  // Refuses a bad first date before the end is checked.
  parseKey(firstDate);
  const { limitCount, untilKey } = seriesEnd(r.end);

  const out: string[] = [];
  const push: Push = (key) => {
    if (untilKey !== null && key > untilKey) return false;
    out.push(key);
    if (out.length > MAX_BULK_DATES) throw new ValidationError(`A series can hold at most ${MAX_BULK_DATES} dates.`);
    return out.length < limitCount || untilKey !== null;
  };

  if (r.kind === "daily") {
    for (let i = 0; ; i++) if (!push(addDays(firstDate, i * r.every))) break;
  } else if (r.kind === "weekly") {
    weeklyDates(firstDate, r, untilKey, push);
  } else {
    monthlyDates(firstDate, r, untilKey, push);
  }
  return out;
}

/** Same agency wall-clock start and end on every occurrence, across DST changes. */
export function expandRecurrence(first: { startAt: Date; endAt: Date }, r: Recurrence): Array<{ startAt: Date; endAt: Date }> {
  const firstDate = agencyDayKey(first.startAt);
  const s = agencyDateParts(first.startAt);
  const e = agencyDateParts(first.endAt);
  const endOffset = dayDiff(firstDate, agencyDayKey(first.endAt));
  return recurrenceDates(firstDate, r).map((date) => ({
    startAt: instantOn(date, s.hour, s.minute),
    endAt: instantOn(addDays(date, endOffset), e.hour, e.minute),
  }));
}

function finish(dates: Iterable<string>): string[] {
  const out = [...new Set(dates)].sort(byText);
  if (out.length > MAX_BULK_DATES) throw new ValidationError(`At most ${MAX_BULK_DATES} dates can be created at once.`);
  return out;
}

/** Sorted, de-duplicated agency date keys (max 366). A range is inclusive. `firstDate` anchors a pattern. */
export function expandDates(selection: DateSelection, firstDate: string): string[] {
  if (selection.kind === "dates") {
    for (const d of selection.dates) parseKey(d);
    return finish(selection.dates);
  }
  if (selection.kind === "pattern") return finish(recurrenceDates(firstDate, selection.recurrence));
  parseKey(selection.from);
  parseKey(selection.to);
  if (selection.to < selection.from) throw new ValidationError("The range must end on or after its start.");
  if (selection.weekdays) assertWeekdays(selection.weekdays);
  const span = dayDiff(selection.from, selection.to) + 1;
  if (span > MAX_BULK_DATES * 7) throw new ValidationError(`At most ${MAX_BULK_DATES} dates can be created at once.`);
  const out: string[] = [];
  for (let i = 0; i < span; i++) {
    const key = addDays(selection.from, i);
    if (!selection.weekdays || selection.weekdays.includes(weekdayOf(key))) out.push(key);
  }
  return finish(out);
}

/**
 * `expandDates` for a selection sent by a date picker, where a repeat's end date arrives as a YYYY-MM-DD string
 * (read as the end of that agency day). Callers check permission first.
 */
export function expandSelection(selection: DateSelection, firstDate: string): string[] {
  if (selection.kind !== "pattern" || !("until" in selection.recurrence.end)) return expandDates(selection, firstDate);
  const until = agencyDateOnly((selection.recurrence.end as { until: unknown }).until, "end");
  if (!until) throw new ValidationError("Choose the date the repeat ends.");
  return expandDates({ kind: "pattern", recurrence: { ...selection.recurrence, end: { until } } }, firstDate);
}

/**
 * Start and end for each date, using the input's agency wall-clock times. An end
 * at or before the start ends the next day. Pure: release settings are passed in.
 */
export function previewBulk(input: Pick<JobInput, "startAt" | "endAt">, dates: string[], overrides: TimeOverrides | undefined, settings: ReleaseSettings): BulkPreview[] {
  if (dates.length > MAX_BULK_DATES) throw new ValidationError(`At most ${MAX_BULK_DATES} dates can be created at once.`);
  const s = agencyDateParts(input.startAt);
  const e = agencyDateParts(input.endAt);
  return dates.map((date) => {
    const o = overrides?.[date];
    const st = o?.startTime ? parseTime(o.startTime) : { h: s.hour, m: s.minute };
    const en = o?.endTime ? parseTime(o.endTime) : { h: e.hour, m: e.minute };
    const nextDay = en.h * 60 + en.m <= st.h * 60 + st.m;
    const startAt = instantOn(date, st.h, st.m);
    const endAt = instantOn(nextDay ? addDays(date, 1) : date, en.h, en.m);
    return { date, startAt, endAt, releaseAt: releaseAt(startAt, settings) };
  });
}
