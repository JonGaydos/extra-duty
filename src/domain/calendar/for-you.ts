import type { Tx } from "@/db/client";
import type { jobs } from "@/db/schema";
import { fitsSchedule, loadDuty } from "../planning/schedule";
import { agencyDateOnly, agencyDateParts, agencyInstant, agencyWeekKey } from "../time/agency-time";

type Row = typeof jobs.$inferSelect;

/** The agency week that holds `now`: its first day at midnight, and the next week's. */
export function agencyWeek(now: Date, weekStartsOn: number): { from: Date; to: Date } {
  const start = agencyDateOnly(agencyWeekKey(now, weekStartsOn as 0 | 1 | 2 | 3 | 4 | 5 | 6))!;
  const p = agencyDateParts(start);
  return { from: agencyInstant(p.year, p.month, p.day, 0, 0), to: agencyInstant(p.year, p.month, p.day + 7, 0, 0) };
}

/**
 * The "For you" filters every Details view shares (List, Calendar and Map): this agency week, flexible times, and
 * only details the person's own schedule allows. "Open spots only" needs each detail's staffing and is applied where
 * that is known.
 */
export async function keepForYou(tx: Tx, userId: string, rows: Row[], f: { week: boolean; flex: boolean; workable: boolean }, now: Date, weekStartsOn: number): Promise<Row[]> {
  let out = rows;
  if (f.week) {
    const w = agencyWeek(now, weekStartsOn);
    out = out.filter((j) => j.startAt >= w.from && j.startAt < w.to);
  }
  if (f.flex) out = out.filter((j) => j.flexEarliestStartAt !== null && j.flexLatestEndAt !== null);
  if (f.workable && out.length) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const j of out) {
      lo = Math.min(lo, j.flexEarliestStartAt?.getTime() ?? j.startAt.getTime());
      hi = Math.max(hi, j.flexLatestEndAt?.getTime() ?? j.endAt.getTime());
    }
    const duty = await loadDuty(tx, userId, new Date(lo), new Date(hi));
    out = out.filter((j) =>
      fitsSchedule(
        { startAt: j.startAt, endAt: j.endAt, flex: j.flexEarliestStartAt && j.flexLatestEndAt ? { earliestStartAt: j.flexEarliestStartAt, latestEndAt: j.flexLatestEndAt, allowShorter: j.flexAllowShorter } : null },
        duty,
      ),
    );
  }
  return out;
}
