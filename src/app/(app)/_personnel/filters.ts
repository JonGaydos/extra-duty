import type { Job, JobSort } from "@/domain/jobs/jobs";
import type { Tx } from "@/db/client";
import type { Actor } from "@/domain/actor";
import { listAllJobs, loadJobCards, type JobCard } from "@/domain/personnel/views";
import { listHiddenVendors } from "@/domain/planning/preferences";
import { agencyDateOnly, agencyDateParts, agencyInstant, agencyWeekKey } from "@/domain/time/agency-time";
import { getSettings } from "@/domain/settings/settings";

export type ListFilters = { q: string; open: boolean; mine: boolean; week: boolean; flex: boolean; type: string; workable: boolean; sort: JobSort };

const SORTS: JobSort[] = ["date", "total_pay", "rate", "vendor"];
const DAY_MS = 86_400_000;
/** How far ahead the lists look. */
const LIST_DAYS = 120;

type Params = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

export function parseFilters(p: Params): ListFilters {
  const sort = one(p.sort) as JobSort;
  return {
    q: one(p.q).slice(0, 100),
    open: one(p.open) === "1",
    mine: one(p.mine) === "1",
    week: one(p.week) === "1",
    flex: one(p.flex) === "1",
    type: one(p.type),
    workable: one(p.workable) === "1",
    sort: SORTS.includes(sort) ? sort : "date",
  };
}

export type FilteredJobs = { cards: JobCard[]; hiddenBySchedule: number; hiddenVendors: number; truncated: boolean };

/**
 * Jobs for the list, the map and Home with the person's filters, read in full within the window (never cut
 * at a page). "Only details I can work" is the service's own private filter; the count it removed comes from
 * the same window and query without it, so the number matches the list.
 */
export async function filteredJobs(actor: Actor, tx: Tx, f: ListFilters, now: Date): Promise<FilteredJobs> {
  let from = now;
  let to = new Date(now.getTime() + LIST_DAYS * DAY_MS);
  if (f.week) {
    const s = await getSettings(tx);
    const start = agencyDateOnly(agencyWeekKey(now, s.weekStartsOn as 0 | 1 | 2 | 3 | 4 | 5 | 6))!;
    const p = agencyDateParts(start);
    to = agencyInstant(p.year, p.month, p.day + 7, 0, 0);
  }
  if (f.mine) from = new Date(now.getTime() - DAY_MS);
  const base = { from, to, runningAt: now, text: f.q || undefined, mine: f.mine || undefined, typeIds: f.type ? [f.type] : undefined, sort: f.sort, direction: f.sort === "date" ? ("asc" as const) : ("desc" as const) };
  const shown = await listAllJobs(actor, tx, { ...base, onlyWorkable: f.workable || undefined });
  const keep = async (rows: Job[]) => {
    let cards = await loadJobCards(actor, tx, rows, now);
    if (f.open) cards = cards.filter((c) => c.availability === "open" && !c.mine);
    if (f.flex) cards = cards.filter((c) => c.flex !== null);
    if (!f.mine) cards = cards.filter((c) => c.availability !== "started" || c.mine);
    return cards;
  };
  const cards = await keep(shown.jobs);
  let hiddenBySchedule = 0;
  let truncated = shown.truncated;
  if (f.workable) {
    const all = await listAllJobs(actor, tx, base);
    truncated ||= all.truncated;
    hiddenBySchedule = Math.max(0, (await keep(all.jobs)).length - cards.length);
  }
  const hiddenVendors = (await listHiddenVendors(actor, tx, actor.userId)).length;
  return { cards, hiddenBySchedule, hiddenVendors, truncated };
}

/** What "Only details I can work" uses, in words. */
export function scheduleNoteFor(schedule: { active: boolean; kind: string; bufferMinutes: number } | null, calendar: boolean): string {
  const parts: string[] = [];
  if (schedule?.active) parts.push(`your ${schedule.kind === "weekly" ? "weekly" : "rotation"} schedule`);
  if (calendar) parts.push("your calendar");
  if (schedule?.active && schedule.bufferMinutes > 0) parts.push(`${schedule.bufferMinutes} min buffer`);
  return parts.length ? `Uses ${parts.join(", ")}` : "Add your schedule in Profile to use this";
}
