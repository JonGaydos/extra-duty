import { TZDate } from "@date-fns/tz";
import { startOfWeek } from "date-fns";
import type { Minutes } from "@/domain/types";

export const AGENCY_TZ = "America/Chicago";

export type AgencyDateParts = {
  year: number;
  month: number; // 1-12
  day: number;
  hour: number;
  minute: number;
};

const pad = (n: number, width = 2) => String(n).padStart(width, "0");

export function agencyDateParts(at: Date): AgencyDateParts {
  const z = new TZDate(at.getTime(), AGENCY_TZ);
  return {
    year: z.getFullYear(),
    month: z.getMonth() + 1,
    day: z.getDate(),
    hour: z.getHours(),
    minute: z.getMinutes(),
  };
}

/**
 * Instant for a wall-clock time in agency time. Months are 1-based.
 * Gap (spring-forward, e.g. 02:30 on the change day): resolves forward by the
 * gap length (02:30 becomes 03:30 CDT). Ambiguous (fall-back, e.g. 01:30):
 * resolves to the first occurrence (CDT, the earlier instant).
 */
export function agencyInstant(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const z = new TZDate(year, month - 1, day, hour, minute, 0, 0, AGENCY_TZ);
  return new Date(z.getTime());
}

/** Whole minutes from start to end (elapsed time, so DST changes count). */
export function minutesBetween(start: Date, end: Date): Minutes {
  return Math.round((end.getTime() - start.getTime()) / 60_000);
}

export function agencyDayKey(at: Date): string {
  const p = agencyDateParts(at);
  return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}

export function agencyMonthKey(at: Date): string {
  const p = agencyDateParts(at);
  return `${pad(p.year, 4)}-${pad(p.month)}`;
}

/** Date key (YYYY-MM-DD) of the first day of the week containing `at`. weekStartsOn: 0 = Sunday. */
export function agencyWeekKey(at: Date, weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6): string {
  const z = new TZDate(at.getTime(), AGENCY_TZ);
  return agencyDayKey(startOfWeek(z, { weekStartsOn }));
}

/**
 * A date-only string (YYYY-MM-DD) as an agency-time instant: midnight at the start of that day, or
 * with `edge: "end"` the last millisecond of it. Returns null for anything else (including full timestamps).
 */
export function agencyDateOnly(value: unknown, edge: "start" | "end" = "start"): Date | null {
  if (typeof value !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(y, mo - 1, d));
  if (check.getUTCFullYear() !== y || check.getUTCMonth() !== mo - 1 || check.getUTCDate() !== d) return null;
  if (edge === "start") return agencyInstant(y, mo, d, 0, 0);
  const next = new Date(Date.UTC(y, mo - 1, d + 1));
  return new Date(agencyInstant(next.getUTCFullYear(), next.getUTCMonth() + 1, next.getUTCDate(), 0, 0).getTime() - 1);
}
