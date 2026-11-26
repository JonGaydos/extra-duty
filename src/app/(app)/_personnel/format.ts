import { AGENCY_TZ, agencyDateParts, agencyDayKey, agencyInstant } from "@/domain/time/agency-time";

/** Display helpers. Every date and time shows in agency time (America/Chicago). */

const fmt = (o: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, ...o });
const WEEKDAY_DATE = fmt({ weekday: "short", month: "short", day: "numeric" });
const LONG_DATE = fmt({ weekday: "long", month: "long", day: "numeric" });
const MONTH_DAY_YEAR = fmt({ month: "short", day: "numeric", year: "numeric" });
const MONTH_DAY = fmt({ month: "short", day: "numeric" });
const MONTH_YEAR = fmt({ month: "long", year: "numeric" });

/** "2:00 PM", or "2 PM" with `short`. */
export function clock(d: Date, short = false): string {
  const p = agencyDateParts(d);
  const h = p.hour % 12 === 0 ? 12 : p.hour % 12;
  const ampm = p.hour < 12 ? "AM" : "PM";
  if (short && p.minute === 0) return `${h} ${ampm}`;
  return `${h}:${String(p.minute).padStart(2, "0")} ${ampm}`;
}

/** "2:00 to 6:00 PM" when both are PM (or both AM), else "7:30 AM to 12:00 PM". */
export function timeRange(start: Date, end: Date): string {
  const a = clock(start);
  const b = clock(end);
  const sameHalf = agencyDateParts(start).hour < 12 === agencyDateParts(end).hour < 12;
  return sameHalf ? `${a.replace(/ (AM|PM)$/, "")} to ${b}` : `${a} to ${b}`;
}

/** "Tue, Dec 1". */
export const dayLabel = (d: Date) => WEEKDAY_DATE.format(d);
/** "Sunday, November 22". */
export const longDay = (d: Date) => LONG_DATE.format(d);
/** "Nov 18, 2026". */
export const dateLabel = (d: Date) => MONTH_DAY_YEAR.format(d);
/** "Nov 18". */
export const monthDay = (d: Date) => MONTH_DAY.format(d);
/** "November 2026". */
export const monthYear = (d: Date) => MONTH_YEAR.format(d);

/** "Today", "Tomorrow" or "Tue, Dec 1". */
export function relativeDay(d: Date, now: Date): string {
  const key = agencyDayKey(d);
  if (key === agencyDayKey(now)) return "Today";
  const p = agencyDateParts(now);
  if (key === agencyDayKey(agencyInstant(p.year, p.month, p.day + 1, 12, 0))) return "Tomorrow";
  return dayLabel(d);
}

/** "Today, 2:00 to 6:00 PM". */
export const whenText = (start: Date, end: Date, now: Date) => `${relativeDay(start, now)}, ${timeRange(start, end)}`;

/** "Nov 18, 2026 at 2:00 PM". */
export const dateTime = (d: Date) => `${dateLabel(d)} at ${clock(d)}`;

/** Minutes to "4 h", "4.5 h" or "6 h 40 m". */
export function hoursText(minutes: number, exact = false): string {
  if (exact) {
    const h = Math.floor(minutes / 60);
    const m = minutes % 60;
    return m === 0 ? `${h} h` : `${h} h ${m} m`;
  }
  return `${Math.round((minutes / 60) * 100) / 100} h`;
}

/** Whole hours for stat tiles: "6". */
export const wholeHours = (minutes: number) => String(Math.round((minutes / 60) * 10) / 10);

/** "YYYY-MM-DDTHH:mm" in agency time, for datetime-local inputs. */
export function localInput(d: Date): string {
  const p = agencyDateParts(d);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Parses "YYYY-MM-DDTHH:mm" as agency wall-clock time. Null when malformed. */
export function fromLocalInput(v: unknown): Date | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  if (!m) return null;
  const d = agencyInstant(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** `before` then the value, or nothing when there is no value: prefixed(", ", "Gym") is ", Gym". */
export const prefixed = (before: string, value: string | null | undefined) => (value ? `${before}${value}` : "");

export const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** "18:00" to "6 PM", "06:30" to "6:30 AM". */
export function hhmmText(v: string): string {
  const [h, m] = v.split(":").map(Number);
  const hh = h % 12 === 0 ? 12 : h % 12;
  const mm = m ? `:${String(m).padStart(2, "0")}` : "";
  return `${hh}${mm} ${h < 12 ? "AM" : "PM"}`;
}
