import { and, asc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import type { Tx } from "@/db/client";
import { assignments, jobPositions, jobs, jobTypes, users, vendorLocations, vendors, vendorTypes } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ForbiddenError } from "../errors";
import { startWindow, type JobSort } from "../jobs/jobs";
import { listAllJobs, loadJobCards, myDetails, type JobCard, type MyDetail } from "../personnel/views";
import { agencyDateOnly, agencyDateParts, agencyDayKey, agencyInstant, agencyWeekKey } from "../time/agency-time";
import { scheduledPayCents } from "../planning/recommend";
import { isReleased } from "../release/release";
import { getSettings } from "../settings/settings";
import { keepForYou } from "./for-you";
import type { Cents } from "../types";

/**
 * Every detail a person may see, for the agency Calendar and the coordinator Details list, with the shared
 * filters. Staff see every detail (vendor requests included, marked as requests); personnel see what their
 * Details list shows; vendors use their own portal. Filters and "My details only" are the person's own.
 */

export const CAL_STATUSES = ["open", "filled", "not_released", "past", "canceled", "requested"] as const;
export type CalStatus = (typeof CAL_STATUSES)[number];

export const STATUS_LABEL: Record<CalStatus, string> = {
  open: "Open",
  filled: "Filled",
  not_released: "Not released",
  past: "Past",
  canceled: "Canceled",
  requested: "Vendor request",
};

export type DetailFilters = {
  vendorIds: string[];
  vendorTypeIds: string[];
  typeIds: string[];
  locationIds: string[];
  statuses: CalStatus[];
  personId: string | null;
  jobNumber: number | null;
  q: string;
  mine: boolean;
  /** Deputy-only (the personnel Details list): open spots I could take, this agency week, flexible times, details my schedule allows, and the order. */
  openOnly: boolean;
  week: boolean;
  flex: boolean;
  workable: boolean;
  sort: JobSort;
  /** Staff only: list only confidential details, or hide them (owner decision 2026-11-27). Others never see the choice. */
  confidential?: "only" | "hide" | null;
};

export const JOB_SORTS = ["date", "total_pay", "rate", "vendor"] as const satisfies readonly JobSort[];

export const NO_FILTERS: DetailFilters = {
  vendorIds: [],
  vendorTypeIds: [],
  typeIds: [],
  locationIds: [],
  statuses: [],
  personId: null,
  jobNumber: null,
  q: "",
  mine: false,
  openOnly: false,
  week: false,
  flex: false,
  workable: false,
  sort: "date",
};

export type CalEntry = {
  id: string;
  number: number;
  title: string;
  vendorId: string;
  vendorName: string;
  locationName: string | null;
  /** The location's address and pin, for Open in Maps. */
  address: string | null;
  lat: number | null;
  lng: number | null;
  typeId: string;
  startAt: Date;
  endAt: Date;
  state: (typeof jobs.$inferSelect)["state"];
  status: CalStatus;
  held: boolean;
  /** Confidential: shown to staff and the people assigned only, with a Confidential chip. */
  confidential: boolean;
  /** The viewer holds a spot or a place in line. */
  mine: boolean;
  /** The viewer's own assignment status when `mine`. */
  myStatus: (typeof assignments.$inferSelect)["status"] | null;
  needed: number;
  filled: number;
  seriesId: string | null;
  pay: { totalCents: Cents; rateCents: Cents; maxTotalCents: Cents; maxRateCents: Cents };
};

/** At most this many details are read for one view; the page says when it was cut. */
const MAX_CAL_ENTRIES = 2000;

const LIVE = ["pending_short", "signed_up", "backup", "billed", "paid", "late_canceled", "no_show"] as const;
const FILLING = ["signed_up", "pending_short", "billed", "paid", "no_show"];

const isStaff = (a: Actor) => a.role === "coordinator" || a.role === "admin";

/** The status word a calendar entry shows; color is never the only signal. */
function calStatus(job: { state: CalEntry["state"]; held: boolean; releaseAt: Date | null; startAt: Date; endAt: Date }, needed: number, filled: number, now: Date): CalStatus {
  if (job.state === "canceled" || job.state === "declined") return "canceled";
  if (job.state === "requested") return "requested";
  if (job.endAt.getTime() <= now.getTime()) return "past";
  if (!isReleased(job, now) && job.startAt.getTime() > now.getTime()) return "not_released";
  return needed - filled > 0 ? "open" : "filled";
}

/**
 * A view's dates: details starting in [from, to]. A "today" or upcoming view sets `runningAt` (now) to also list
 * details that started earlier and are still running; the month grid, which places details by start day, does not.
 */
export type DetailRange = { from: Date; to: Date; runningAt?: Date };

/** The agency day a listed detail goes under: its start day, or the list's first day if it started earlier and is still running. */
export function listedDay(startAt: Date, from: Date): string {
  return agencyDayKey(startAt < from ? from : startAt);
}

/** The details in range the actor may see on the calendar, at most MAX_CAL_ENTRIES for staff. */
async function calendarJobs(actor: Actor, tx: Tx, range: DetailRange, f: DetailFilters): Promise<{ rows: Array<typeof jobs.$inferSelect>; truncated: boolean }> {
  if (isStaff(actor)) {
    const rows = await tx
      .select()
      .from(jobs)
      .where(startWindow(range))
      .orderBy(asc(jobs.startAt), asc(jobs.number))
      .limit(MAX_CAL_ENTRIES + 1);
    return { rows: rows.slice(0, MAX_CAL_ENTRIES), truncated: rows.length > MAX_CAL_ENTRIES };
  }
  // The personnel lists' own visibility: no requests, held details only for people on them, hidden vendors left out.
  const r = await listAllJobs(actor, tx, { from: range.from, to: range.to, runningAt: range.runningAt, mine: f.mine || undefined });
  return { rows: r.jobs, truncated: r.truncated };
}

/** An empty picker keeps every row; otherwise the row needs a value the picker lists. */
function inPicker<T>(picked: readonly T[], value: T | null | undefined): boolean {
  return picked.length === 0 || (!!value && picked.includes(value));
}

/** "1234" or "#1234" is a job number; anything else matches the title, description, vendor or place. */
function matchesText(q: string, job: typeof jobs.$inferSelect, vendorName: string, locationName: string | null): boolean {
  if (!q) return true;
  const asNumber = /^#?(\d{1,9})$/.exec(q);
  if (asNumber && job.number === Number(asNumber[1])) return true;
  return [job.title, job.description ?? "", vendorName, locationName ?? ""].some((t) => t.toLowerCase().includes(q));
}

type EntryFacts = {
  vendorTypeId: string | null | undefined;
  vendorName: string;
  locationName: string | null;
  on: Array<{ userId: string; status: string }>;
  mine: boolean;
  status: CalStatus;
};

/** A spot the person could still take: as the job card counts it, a pending shorter shift does not hold a spot. */
function openForThem(job: typeof jobs.$inferSelect, needed: number, on: Array<{ status: string }>, mine: boolean, status: CalStatus, now: Date): boolean {
  if (mine || job.startAt.getTime() <= now.getTime() || status === "not_released" || status === "canceled" || status === "requested") return false;
  const taken = on.filter((p) => p.status !== "pending_short" && FILLING.includes(p.status)).length;
  return needed - taken > 0;
}

/** Whether a detail passes the shared filters (`q` already trimmed and lowercased). */
function keptByFilters(f: DetailFilters, q: string, job: typeof jobs.$inferSelect, e: EntryFacts): boolean {
  if (f.mine && !e.mine) return false;
  const picked =
    inPicker(f.vendorIds, job.vendorId) &&
    inPicker(f.vendorTypeIds, e.vendorTypeId) &&
    inPicker(f.typeIds, job.typeId) &&
    inPicker(f.locationIds, job.locationId) &&
    inPicker(f.statuses, e.status);
  if (!picked) return false;
  if (f.personId && !e.on.some((p) => p.userId === f.personId && p.status !== "late_canceled")) return false;
  if (f.jobNumber !== null && job.number !== f.jobNumber) return false;
  if (f.confidential && job.confidential !== (f.confidential === "only")) return false;
  return matchesText(q, job, e.vendorName, e.locationName);
}

export async function calendarEntries(actor: Actor, tx: Tx, range: DetailRange, f: DetailFilters, now: Date = new Date()): Promise<{ entries: CalEntry[]; truncated: boolean }> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "job.read");
  const read = await calendarJobs(actor, tx, range, f);
  const { truncated } = read;
  const settings = await getSettings(tx);
  // The For you filters apply in every view (List, Calendar and Map share one filter set).
  const rows = await keepForYou(tx, actor.userId, read.rows, f, now, settings.weekStartsOn);
  if (rows.length === 0) return { entries: [], truncated };

  const ids = rows.map((j) => j.id);
  const vendorRows = await tx.select({ id: vendors.id, name: vendors.name, typeId: vendors.typeId, minimum: vendors.minimumBillableMinutes }).from(vendors).where(inArray(vendors.id, [...new Set(rows.map((j) => j.vendorId))]));
  const vendorById = new Map(vendorRows.map((v) => [v.id, v]));
  const locIds = [...new Set(rows.map((j) => j.locationId).filter((x): x is string => !!x))];
  const locById = new Map((locIds.length ? await tx.select({ id: vendorLocations.id, name: vendorLocations.name, address: vendorLocations.address, lat: vendorLocations.lat, lng: vendorLocations.lng }).from(vendorLocations).where(inArray(vendorLocations.id, locIds)) : []).map((l) => [l.id, l]));
  const posRows = await tx.select({ id: jobPositions.id, jobId: jobPositions.jobId, count: jobPositions.count, diff: jobPositions.rateDifferentialCents }).from(jobPositions).where(inArray(jobPositions.jobId, ids));
  const people = await tx
    .select({ jobId: assignments.jobId, positionId: assignments.jobPositionId, userId: assignments.userId, status: assignments.status })
    .from(assignments)
    .where(and(inArray(assignments.jobId, ids), inArray(assignments.status, [...LIVE])));

  const q = f.q.trim().toLowerCase();
  const out: CalEntry[] = [];
  for (const job of rows) {
    const vendor = vendorById.get(job.vendorId);
    const loc = job.locationId ? locById.get(job.locationId) : undefined;
    const locationName = loc?.name ?? null;
    const on = people.filter((p) => p.jobId === job.id);
    const own = on.find((p) => p.userId === actor.userId && p.status !== "late_canceled" && p.status !== "no_show");
    const mine = !!own;
    const positions = posRows.filter((p) => p.jobId === job.id);
    const needed = positions.reduce((n, p) => n + p.count, 0);
    const filled = on.filter((p) => FILLING.includes(p.status)).length;
    const status = calStatus(job, needed, filled, now);

    if (!keptByFilters(f, q, job, { vendorTypeId: vendor?.typeId, vendorName: vendor?.name ?? "", locationName, on, mine, status })) continue;
    // Open spots only: a spot the person could still take, as the job card counts it (a pending shorter shift does
    // not hold a spot), released, not started and not theirs.
    if (f.openOnly && !openForThem(job, needed, on, mine, status, now)) continue;

    const span = { startAt: job.startAt, endAt: job.endAt };
    // As on the job card: a person on the detail sees their own position's pay; everyone else the base and the highest.
    const ownPosition = own ? positions.find((p) => p.id === own.positionId) : undefined;
    const rateCents = job.rateCents + (ownPosition?.diff ?? 0);
    const maxRateCents = ownPosition ? rateCents : job.rateCents + Math.max(0, ...positions.map((p) => p.diff));
    out.push({
      id: job.id,
      number: job.number,
      title: job.title,
      vendorId: job.vendorId,
      vendorName: vendor?.name ?? "",
      locationName,
      address: loc?.address ?? null,
      lat: loc?.lat ?? null,
      lng: loc?.lng ?? null,
      typeId: job.typeId,
      startAt: job.startAt,
      endAt: job.endAt,
      state: job.state,
      status,
      held: job.held,
      confidential: job.confidential,
      mine,
      myStatus: own?.status ?? null,
      needed,
      filled,
      seriesId: job.seriesId,
      pay: {
        rateCents,
        totalCents: scheduledPayCents({ ...job, rateCents }, vendor?.minimum ?? null, settings, span),
        maxRateCents,
        maxTotalCents: scheduledPayCents({ ...job, rateCents: maxRateCents }, vendor?.minimum ?? null, settings, span),
      },
    });
  }
  return { entries: out, truncated };
}

/**
 * The Details list: job cards (pay, staffing, the person's own status) for the details the shared filters keep, in
 * date order. Details that started are left out unless the person is on them, or `keepStarted` (staff, who manage
 * a running detail until it ends).
 */
export async function detailCards(
  actor: Actor,
  tx: Tx,
  range: DetailRange,
  f: DetailFilters,
  now: Date = new Date(),
  opts: { keepStarted?: boolean } = {},
): Promise<{ cards: JobCard[]; truncated: boolean; hiddenBySchedule: number; gone: MyDetail[] }> {
  // With My details only, the person's canceled or removed sign-ups stay listed (30 days) with the reason.
  const gone = f.mine ? (await myDetails(actor, tx, now, range)).filter((d) => d.reason !== null) : [];
  let to = range.to;
  if (f.week) {
    const s = await getSettings(tx);
    const start = agencyDateOnly(agencyWeekKey(now, s.weekStartsOn as 0 | 1 | 2 | 3 | 4 | 5 | 6))!;
    const p = agencyDateParts(start);
    to = new Date(Math.min(to.getTime(), agencyInstant(p.year, p.month, p.day + 7, 0, 0).getTime()));
  }
  const window = { from: range.from, to, runningAt: range.runningAt };
  // Workable is applied below with the schedule's own count of what it hid.
  const { entries, truncated } = await calendarEntries(actor, tx, window, { ...f, workable: false }, now);
  const keep = new Set(entries.map((e) => e.id));
  if (keep.size === 0) return { cards: [], truncated, hiddenBySchedule: 0, gone };
  const base = { ...window, mine: f.mine || undefined, sort: f.sort, direction: f.sort === "date" ? ("asc" as const) : ("desc" as const) };
  const shown = (await listAllJobs(actor, tx, { ...base, onlyWorkable: f.workable || undefined })).jobs.filter((j) => keep.has(j.id));
  const toCards = async (rows: typeof shown) =>
    (await loadJobCards(actor, tx, rows, now)).filter(
      (c) => (c.availability !== "started" || c.mine || opts.keepStarted) && (!f.openOnly || (c.availability === "open" && !c.mine)) && (!f.flex || c.flex !== null),
    );
  const cards = await toCards(shown);
  // "Only details I can work" is the person's private schedule filter: say how many it hid.
  const hiddenBySchedule = f.workable ? Math.max(0, (await toCards((await listAllJobs(actor, tx, base)).jobs.filter((j) => keep.has(j.id)))).length - cards.length) : 0;
  return { cards, truncated, hiddenBySchedule, gone };
}

export type FilterOptions = {
  vendors: Array<{ id: string; name: string }>;
  vendorTypes: Array<{ id: string; name: string }>;
  types: Array<{ id: string; name: string }>;
  locations: Array<{ id: string; name: string }>;
  people: Array<{ id: string; name: string }>;
  statuses: CalStatus[];
};

/**
 * Choices for the filter panel. Staff choose from every vendor, place and person; personnel from the vendors and
 * places of details they can see in the range and the people on those details' rosters.
 */
export async function filterOptions(actor: Actor, tx: Tx, range: DetailRange): Promise<FilterOptions> {
  if (actor.role === "vendor") throw new ForbiddenError();
  assertCan(actor, "job.read");
  const types = await tx.select({ id: jobTypes.id, name: jobTypes.name }).from(jobTypes).where(eq(jobTypes.active, true)).orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name));
  const vtypes = await tx.select({ id: vendorTypes.id, name: vendorTypes.name }).from(vendorTypes).where(eq(vendorTypes.active, true)).orderBy(asc(vendorTypes.sortOrder), asc(vendorTypes.name));
  if (isStaff(actor)) {
    return {
      vendors: await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).orderBy(asc(vendors.name)),
      vendorTypes: vtypes,
      types,
      locations: await tx.select({ id: vendorLocations.id, name: vendorLocations.name }).from(vendorLocations).where(eq(vendorLocations.active, true)).orderBy(asc(vendorLocations.name)),
      people: await tx.select({ id: users.id, name: users.name }).from(users).where(and(eq(users.active, true), inArray(users.role, ["personnel", "coordinator", "admin"]))).orderBy(asc(users.name)),
      statuses: [...CAL_STATUSES],
    };
  }
  const visible = (await listAllJobs(actor, tx, range)).jobs;
  const ids = visible.map((j) => j.id);
  const vendorIds = [...new Set(visible.map((j) => j.vendorId))];
  const locIds = [...new Set(visible.map((j) => j.locationId).filter((x): x is string => !!x))];
  const roster = ids.length
    ? await tx
        .selectDistinct({ id: users.id, name: users.name })
        .from(assignments)
        .innerJoin(users, eq(users.id, assignments.userId))
        .where(and(inArray(assignments.jobId, ids), inArray(assignments.status, ["pending_short", "signed_up", "backup", "billed", "paid"])))
        .orderBy(asc(users.name))
    : [];
  return {
    vendors: vendorIds.length ? await tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, vendorIds)).orderBy(asc(vendors.name)) : [],
    vendorTypes: vtypes,
    types,
    locations: locIds.length ? await tx.select({ id: vendorLocations.id, name: vendorLocations.name }).from(vendorLocations).where(inArray(vendorLocations.id, locIds)).orderBy(asc(vendorLocations.name)) : [],
    people: roster,
    statuses: CAL_STATUSES.filter((s) => s !== "requested"),
  };
}

const filtersSchema = z.object({
  vendorIds: z.array(z.string().max(64)).max(500).default([]),
  vendorTypeIds: z.array(z.string().max(64)).max(100).default([]),
  typeIds: z.array(z.string().max(64)).max(100).default([]),
  locationIds: z.array(z.string().max(64)).max(1000).default([]),
  statuses: z.array(z.enum(CAL_STATUSES)).max(6).default([]),
  personId: z.string().max(64).nullable().default(null),
  jobNumber: z.number().int().positive().nullable().default(null),
  q: z.string().max(100).default(""),
  mine: z.boolean().default(false),
  openOnly: z.boolean().default(false),
  week: z.boolean().default(false),
  flex: z.boolean().default(false),
  workable: z.boolean().default(false),
  sort: z.enum(JOB_SORTS).default("date"),
  confidential: z.enum(["only", "hide"]).nullable().optional(),
});
const personalSchema = z.object({
  openOnly: z.boolean().default(false),
  week: z.boolean().default(false),
  flex: z.boolean().default(false),
  workable: z.boolean().default(false),
  sort: z.enum(JOB_SORTS).default("date"),
});
const prefsSchema = z.object({
  mine: z.boolean().default(false),
  remember: z.boolean().default(false),
  filters: filtersSchema.nullable().default(null),
  personal: personalSchema.nullable().default(null),
});

/** The deputy-only filters, shown and saved only by the personnel Details list. */
export type PersonalFilters = Pick<DetailFilters, "openOnly" | "week" | "flex" | "workable" | "sort">;

/** Filters without the deputy-only ones (what the Calendar and the coordinator Details list show). */
export function sharedOnly(f: DetailFilters): DetailFilters {
  return { ...f, openOnly: false, week: false, flex: false, workable: false, sort: "date" };
}
function personalOnly(f: DetailFilters): PersonalFilters {
  return { openOnly: f.openOnly, week: f.week, flex: f.flex, workable: f.workable, sort: f.sort };
}

/**
 * "My details only" is always kept; the shared filters when the person chose Remember; the deputy-only filters
 * (`personal`) separately, saved only from the view that shows them.
 */
export type FilterPrefs = { mine: boolean; remember: boolean; filters: DetailFilters | null; personal: PersonalFilters | null };

/** The person's own saved filters. Nobody else's are ever read. */
export async function getFilterPrefs(actor: Actor, tx: Tx): Promise<FilterPrefs> {
  const [row] = await tx.select({ v: users.detailFilters }).from(users).where(eq(users.id, actor.userId));
  const parsed = prefsSchema.safeParse(row?.v ?? {});
  return parsed.success ? parsed.data : { mine: false, remember: false, filters: null, personal: null };
}

export async function saveFilterPrefs(actor: Actor, tx: Tx, prefs: Omit<FilterPrefs, "personal"> & { personal?: PersonalFilters | null }): Promise<FilterPrefs> {
  if (actor.role === "vendor") throw new ForbiddenError();
  const before = await getFilterPrefs(actor, tx);
  const next = prefsSchema.parse({
    mine: prefs.mine,
    remember: prefs.remember,
    filters: prefs.remember && prefs.filters ? sharedOnly(prefs.filters) : null,
    personal: prefs.personal === undefined ? before.personal : prefs.personal,
  });
  if (JSON.stringify(before) === JSON.stringify(next)) return next;
  await tx.update(users).set({ detailFilters: next }).where(eq(users.id, actor.userId));
  await recordAudit(tx, { actor, action: "user.detail_filters", entityType: "user", entityId: actor.userId, before, after: next });
  return next;
}

/**
 * Apply or Reset from one view. A view saves only what it shows: the shared filters and Remember always, the
 * deputy-only filters only when `personal` (the personnel Details list); other views leave them as they are.
 */
export async function saveViewFilters(actor: Actor, tx: Tx, v: { mine: boolean; remember: boolean; filters: DetailFilters; personal: boolean }): Promise<FilterPrefs> {
  return saveFilterPrefs(actor, tx, {
    mine: v.mine,
    remember: v.remember,
    filters: v.filters,
    ...(v.personal ? { personal: v.remember ? personalOnly(v.filters) : null } : {}),
  });
}
