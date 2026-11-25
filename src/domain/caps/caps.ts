import type { Minutes } from "@/domain/types";
import { ValidationError } from "../errors";
import { agencyDateParts, agencyInstant, agencyMonthKey, agencyWeekKey, minutesBetween } from "../time/agency-time";
import { seasonFor, type Season } from "./seasons";

export type Interval = { startAt: Date; endAt: Date };

export type CapResult = {
  cap: "rolling" | "week" | "month";
  period: string;
  usedMinutes: Minutes;
  limitMinutes: Minutes;
  ok: boolean;
};

export type CapInput = {
  existing: Interval[];
  candidate: Interval;
  seasons: Season[];
  /** 0 = Sunday. */
  weekStartsOn: number;
  rollingWindowHours: number;
};

type Span = [number, number];

/** Sorted, merged spans so overlapping data is never double counted. */
function merge(intervals: Interval[]): Span[] {
  const spans = intervals
    .map((i): Span => [i.startAt.getTime(), i.endAt.getTime()])
    .filter(([s, e]) => e > s)
    .sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const [s, e] of spans) {
    const last = out[out.length - 1];
    if (last && s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}

/** Splits a span at agency-time midnights; each piece lies within one agency day. */
function dayPieces([s, e]: Span): Span[] {
  const pieces: Span[] = [];
  let cursor = s;
  while (cursor < e) {
    const p = agencyDateParts(new Date(cursor));
    const next = agencyInstant(p.year, p.month, p.day + 1, 0, 0).getTime();
    const end = Math.min(next, e);
    pieces.push([cursor, end]);
    cursor = end;
  }
  return pieces;
}

const toMinutes = (a: number, b: number): Minutes => minutesBetween(new Date(a), new Date(b));

/** Season of a period, taken from its first day (noon avoids any midnight edge). */
function seasonOfKey(key: string, seasons: Season[]): Season | null {
  const [y, m, d] = key.split("-").map(Number);
  return seasonFor(agencyInstant(y, m, d ?? 1, 12, 0), seasons);
}

export function evaluateCaps(input: CapInput): CapResult[] {
  const { candidate, seasons } = input;
  if (!(candidate.endAt.getTime() > candidate.startAt.getTime())) {
    throw new ValidationError("The detail must end after it starts.");
  }
  if (!Number.isInteger(input.weekStartsOn) || input.weekStartsOn < 0 || input.weekStartsOn > 6) {
    throw new ValidationError("The week must start on a day from 0 (Sunday) to 6 (Saturday).");
  }
  const weekStartsOn = input.weekStartsOn as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const merged = merge([...input.existing, candidate]);
  const results: CapResult[] = [];

  // Rolling window.
  const cs = candidate.startAt.getTime();
  const ce = candidate.endAt.getTime();
  const rollingLimit = seasonFor(candidate.startAt, seasons)?.rollingCapMinutes ?? null;
  if (rollingLimit !== null) {
    const windowMs = input.rollingWindowHours * 3_600_000;
    // The candidate's own anchors keep a window overlapping it even inside one long merged block.
    const starts = new Set<number>([cs, ce - windowMs]);
    for (const [s, e] of merged) {
      starts.add(s);
      starts.add(e - windowMs);
    }
    let best: { used: Minutes; start: number } | null = null;
    for (const w of [...starts].sort((a, b) => a - b)) {
      if (!(w < ce && w + windowMs > cs)) continue;
      let used = 0;
      for (const [s, e] of merged) {
        const lo = Math.max(s, w);
        const hi = Math.min(e, w + windowMs);
        if (hi > lo) used += toMinutes(lo, hi);
      }
      if (!best || used > best.used) best = { used, start: w };
    }
    if (best) {
      results.push({
        cap: "rolling",
        period: `${new Date(best.start).toISOString()}/${new Date(best.start + windowMs).toISOString()}`,
        usedMinutes: best.used,
        limitMinutes: rollingLimit,
        ok: best.used <= rollingLimit,
      });
    }
  }

  // Calendar week and month totals, split at agency-time boundaries.
  const weekUsed = new Map<string, Minutes>();
  const monthUsed = new Map<string, Minutes>();
  for (const span of merged) {
    for (const [a, b] of dayPieces(span)) {
      const at = new Date(a);
      const mins = toMinutes(a, b);
      const wk = agencyWeekKey(at, weekStartsOn);
      const mk = agencyMonthKey(at);
      weekUsed.set(wk, (weekUsed.get(wk) ?? 0) + mins);
      monthUsed.set(mk, (monthUsed.get(mk) ?? 0) + mins);
    }
  }
  const touchedWeeks = new Set<string>();
  const touchedMonths = new Set<string>();
  for (const [a] of dayPieces([cs, ce])) {
    touchedWeeks.add(agencyWeekKey(new Date(a), weekStartsOn));
    touchedMonths.add(agencyMonthKey(new Date(a)));
  }

  const push = (cap: "week" | "month", keys: Set<string>, used: Map<string, Minutes>) => {
    for (const key of [...keys].sort()) {
      const limit = seasonOfKey(key, seasons)?.[cap === "week" ? "weekCapMinutes" : "monthCapMinutes"] ?? null;
      if (limit === null) continue;
      const u = used.get(key) ?? 0;
      results.push({ cap, period: key, usedMinutes: u, limitMinutes: limit, ok: u <= limit });
    }
  };
  push("week", touchedWeeks, weekUsed);
  push("month", touchedMonths, monthUsed);
  return results;
}
