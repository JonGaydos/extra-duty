import { agencyDateOnly, agencyDateParts, agencyDayKey, agencyInstant } from "@/domain/time/agency-time";

const CLOCK = /^([01]\d|2[0-3]):([0-5]\d)$/;
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A detail's date and start and end clock times (agency time) as instants. An end at or before the start
 * finishes the next day, so a 10 PM to 2 AM detail crosses midnight. Null when any value is missing or malformed.
 */
export function spanFromInputs(date: string, start: string, end: string): { startAt: Date; endAt: Date } | null {
  const day = agencyDateOnly(date);
  const s = CLOCK.exec(start);
  const e = CLOCK.exec(end);
  if (!day || !s || !e) return null;
  const p = agencyDateParts(day);
  const startAt = agencyInstant(p.year, p.month, p.day, Number(s[1]), Number(s[2]));
  let endAt = agencyInstant(p.year, p.month, p.day, Number(e[1]), Number(e[2]));
  if (endAt.getTime() <= startAt.getTime()) endAt = agencyInstant(p.year, p.month, p.day + 1, Number(e[1]), Number(e[2]));
  return { startAt, endAt };
}

/** A saved span as the form's date and clock times. */
export function spanInputs(startAt: Date, endAt: Date): { date: string; start: string; end: string } {
  const s = agencyDateParts(startAt);
  const e = agencyDateParts(endAt);
  return { date: agencyDayKey(startAt), start: `${pad(s.hour)}:${pad(s.minute)}`, end: `${pad(e.hour)}:${pad(e.minute)}` };
}
