import { seasonFor, type Season } from "@/domain/caps/seasons";
import { agencyDateParts } from "@/domain/time/agency-time";

export type DayRange = { from: string; to: string };
type SeasonDates = Pick<Season, "name" | "startMonthDay" | "endMonthDay">;

const pad = (n: number) => String(n).padStart(2, "0");
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/**
 * The activity report's presets as agency days (YYYY-MM-DD): this month, this year, and the season that covers
 * today (null when none does). A season that wraps the year end runs from its start in one year to its end in the next.
 */
export function activityPeriods(now: Date, seasons: SeasonDates[]): { month: DayRange; year: DayRange; season: (DayRange & { name: string }) | null } {
  const p = agencyDateParts(now);
  const month = { from: `${p.year}-${pad(p.month)}-01`, to: `${p.year}-${pad(p.month)}-${pad(lastDay(p.year, p.month))}` };
  const year = { from: `${p.year}-01-01`, to: `${p.year}-12-31` };
  const s = seasonFor(now, seasons as Season[]);
  if (!s) return { month, year, season: null };
  const today = `${pad(p.month)}-${pad(p.day)}`;
  const wraps = s.startMonthDay > s.endMonthDay;
  const startYear = wraps && today <= s.endMonthDay ? p.year - 1 : p.year;
  const endYear = wraps ? startYear + 1 : startYear;
  return { month, year, season: { name: s.name, from: `${startYear}-${s.startMonthDay}`, to: `${endYear}-${s.endMonthDay}` } };
}
