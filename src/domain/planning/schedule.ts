import { and, asc, eq, gte, lte } from "drizzle-orm";
import ICAL from "ical.js";
import type { Tx } from "@/db/client";
import { calendarBusy, calendarFeeds, scheduleExceptions, workSchedules } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { TZDate } from "@date-fns/tz";
import { agencyDateOnly, agencyDateParts, agencyInstant } from "../time/agency-time";

type IcsComponent = InstanceType<typeof ICAL.Component>;
type IcsEvent = InstanceType<typeof ICAL.Event>;
type IcsTime = InstanceType<typeof ICAL.Time>;

export type Interval = { startAt: Date; endAt: Date };
export type WorkSchedule = Pick<typeof workSchedules.$inferSelect, "kind" | "weekdays" | "cycle" | "anchorDate" | "shiftStart" | "shiftEnd" | "bufferMinutes" | "active">;
export type ScheduleException = Pick<typeof scheduleExceptions.$inferSelect, "date" | "kind" | "shiftStart" | "shiftEnd">;
export type PlannedJob = { startAt: Date; endAt: Date; flex?: { earliestStartAt: Date; latestEndAt: Date; allowShorter: boolean } | null };

const BUFFER_CHOICES = [0, 15, 30, 45, 60] as const;
const MINUTE = 60_000;
const STEP = 15 * MINUTE;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function validateBuffer(minutes: number): void {
  if (!(BUFFER_CHOICES as readonly number[]).includes(minutes)) {
    throw new ValidationError("The travel buffer must be none, 15, 30, 45 minutes or 1 hour.");
  }
}

function clock(value: string | null, label: string): [number, number] {
  const m = value ? TIME.exec(value) : null;
  if (!m) throw new ValidationError(`${label} must be a time such as 08:00.`);
  return [Number(m[1]), Number(m[2])];
}

function dateParts(key: string): [number, number, number] {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m || !agencyDateOnly(key)) throw new ValidationError("Dates must look like 2026-11-02.");
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

const utcDay = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d) / 86_400_000;

/** A shift on one agency date; an end that is not after the start ends the next day. */
function shiftOn(y: number, m: number, d: number, start: string, end: string): Interval {
  const [sh, sm] = clock(start, "The shift start");
  const [eh, em] = clock(end, "The shift end");
  const startAt = agencyInstant(y, m, d, sh, sm);
  let endAt = agencyInstant(y, m, d, eh, em);
  if (endAt.getTime() <= startAt.getTime()) endAt = agencyInstant(y, m, d + 1, eh, em);
  return { startAt, endAt };
}

/** Whether a pattern works the agency date `d` (UTC-day number `day`): its weekday, or its rotation day since the anchor. */
function worksOn(s: WorkSchedule, day: number, d: Date, anchor: [number, number, number] | null): boolean {
  if (s.kind === "weekly") return (s.weekdays ?? []).includes(d.getUTCDay());
  if (!s.cycle || !anchor) return false;
  const n = s.cycle.length;
  const idx = (((day - utcDay(...anchor)) % n) + n) % n;
  return s.cycle[idx] === "1";
}

type DateParts = { year: number; month: number; day: number };

/** Each shift a pattern works on the agency dates from `first` to `last`, except days off. */
function patternShifts(s: WorkSchedule, first: DateParts, last: DateParts, offDays: Set<string>, push: (i: Interval) => void): void {
  const pad = (n: number) => String(n).padStart(2, "0");
  const anchor = s.kind === "rotation" ? dateParts(s.anchorDate) : null;
  // Walk agency dates by UTC-day arithmetic, so DST never shifts a rotation day.
  for (let day = utcDay(first.year, first.month, first.day); day <= utcDay(last.year, last.month, last.day); day++) {
    const d = new Date(day * 86_400_000);
    const [y, m, dd] = [d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()];
    if (offDays.has(`${y}-${pad(m)}-${pad(dd)}`)) continue;
    if (worksOn(s, day, d, anchor)) push(shiftOn(y, m, dd, s.shiftStart, s.shiftEnd));
  }
}

/**
 * On-duty intervals overlapping [from, to), in agency time, each widened by the buffer on both sides.
 * Weekly schedules run on chosen weekdays; rotations on the days whose cycle character is '1'
 * (index = days since the anchor date, modulo the cycle length). `off` exceptions drop that date's
 * scheduled shift; `extra` ones add a shift.
 */
export function dutyIntervals(schedules: WorkSchedule[], exceptions: ScheduleException[], from: Date, to: Date): Interval[] {
  const out: Interval[] = [];
  const first = agencyDateParts(new Date(from.getTime() - 2 * 86_400_000));
  const last = agencyDateParts(new Date(to.getTime() + 86_400_000));
  const offDays = new Set(exceptions.filter((e) => e.kind === "off").map((e) => e.date));
  const pusher = (bufferMinutes: number) => (i: Interval) => {
    const startAt = new Date(i.startAt.getTime() - bufferMinutes * MINUTE);
    const endAt = new Date(i.endAt.getTime() + bufferMinutes * MINUTE);
    if (startAt.getTime() < to.getTime() && endAt.getTime() > from.getTime()) out.push({ startAt, endAt });
  };
  for (const s of schedules) {
    if (s.active) patternShifts(s, first, last, offDays, pusher(s.bufferMinutes));
  }
  // Extra shifts stand on their own: they apply even with no active pattern (buffer from the person's schedule, else none).
  const push = pusher(schedules[0]?.bufferMinutes ?? 0);
  for (const e of exceptions) {
    if (e.kind !== "extra" || !e.shiftStart || !e.shiftEnd) continue;
    const [y, m, d] = dateParts(e.date);
    push(shiftOn(y, m, d, e.shiftStart, e.shiftEnd));
  }
  return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime());
}

const overlaps = (a: Interval, b: Interval) => a.startAt.getTime() < b.endAt.getTime() && b.startAt.getTime() < a.endAt.getTime();

/**
 * The detail's own times when they are free of `busy`; otherwise, for a flexible detail, the earliest start
 * (in 15-minute steps from the earliest allowed start) whose same-length window fits inside the flex range.
 */
export function bestPlacement(job: PlannedJob, busy: Interval[]): Interval | null {
  const free = (i: Interval) => !busy.some((b) => overlaps(i, b));
  const own = { startAt: job.startAt, endAt: job.endAt };
  if (free(own)) return own;
  if (!job.flex) return null;
  const length = job.endAt.getTime() - job.startAt.getTime();
  for (let s = job.flex.earliestStartAt.getTime(); s + length <= job.flex.latestEndAt.getTime(); s += STEP) {
    const candidate = { startAt: new Date(s), endAt: new Date(s + length) };
    if (free(candidate)) return candidate;
  }
  return null;
}

export function fitsSchedule(job: PlannedJob, duty: Interval[]): boolean {
  return bestPlacement(job, duty) !== null;
}

// ---------------------------------------------------------------- calendar files

type Busy = Interval & { title: string };

/** Hard bounds on one calendar file, so a crafted feed cannot burn CPU or fill the database. */
export const MAX_BUSY_ROWS = 5000;
const MAX_ITERATIONS = 100_000;
const PARSE_BUDGET_MS = 2000;

/** The file is valid but too big or too expensive to expand. */
export class CalendarLimitError extends ValidationError {}

export const MAX_TITLE_LENGTH = 200;

/** Titles are private; strip NULs (Postgres rejects them) and cap the length. */
function cleanTitle(title: string | null): string {
  return (title ?? "").split(String.fromCodePoint(0)).join("").trim().slice(0, MAX_TITLE_LENGTH) || "Busy";
}

function propText(c: IcsComponent, name: string): string | null {
  const v = c.getFirstPropertyValue(name);
  return typeof v === "string" ? v : null;
}

function isFree(c: IcsComponent): boolean {
  if (propText(c, "status")?.toUpperCase() === "CANCELLED") return true;
  if (propText(c, "transp")?.toUpperCase() === "TRANSPARENT") return true;
  return propText(c, "x-microsoft-cdo-busystatus")?.toUpperCase() === "FREE";
}

function ianaZone(tzid: string | null): string | null {
  if (!tzid) return null;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tzid });
    return tzid;
  } catch {
    return null;
  }
}

/**
 * An instant for an iCalendar time. Dates are agency midnight; a time whose TZID has no VTIMEZONE block but is a
 * valid IANA zone is read in that zone; any other floating time is agency wall-clock time.
 */
function instant(t: IcsTime, tzid: string | null): Date {
  if (t.isDate) return agencyInstant(t.year, t.month, t.day, 0, 0);
  if (t.zone === ICAL.Timezone.localTimezone) {
    const zone = ianaZone(tzid);
    if (zone) return new Date(new TZDate(t.year, t.month - 1, t.day, t.hour, t.minute, t.second, 0, zone).getTime());
    return agencyInstant(t.year, t.month, t.day, t.hour, t.minute);
  }
  return t.toJSDate();
}

const tzidOf = (c: IcsComponent, prop: "dtstart" | "dtend"): string | null => {
  const v = c.getFirstProperty(prop)?.getParameter("tzid");
  return typeof v === "string" ? v : null;
};

/** The parsed calendar, or a ValidationError when it is not one. */
function readCalendar(ics: string): IcsComponent {
  let root: IcsComponent;
  try {
    root = new ICAL.Component(ICAL.parse(ics));
  } catch {
    throw new ValidationError("That file is not a valid calendar.");
  }
  if (root.name !== "vcalendar") throw new ValidationError("That file is not a valid calendar.");
  return root;
}

/** One-off events and recurring masters (with their exceptions related by UID). Unreadable events are skipped. */
function sortEvents(root: IcsComponent, spend: () => void): { singles: IcsEvent[]; masters: Map<string, IcsEvent> } {
  const masters = new Map<string, IcsEvent>();
  const singles: IcsEvent[] = [];
  const exceptions: IcsEvent[] = [];
  for (const v of root.getAllSubcomponents("vevent")) {
    spend();
    if (!v.hasProperty("dtstart")) continue;
    let ev: IcsEvent;
    try {
      // An empty exceptions list stops ical.js from scanning every sibling VEVENT (quadratic); exceptions are related by UID below.
      ev = new ICAL.Event(v, { exceptions: [] });
    } catch {
      continue;
    }
    if (ev.isRecurrenceException()) exceptions.push(ev);
    else if (ev.isRecurring()) masters.set(ev.uid, ev);
    else singles.push(ev);
  }
  for (const ex of exceptions) masters.get(ex.uid)?.relateException(ex);
  return { singles, masters };
}

/** When an entry ends: its own end, else (no end) the end of its all-day date or its start. An all-day entry never ends before its day does. */
function busyEnd(c: IcsComponent, start: IcsTime, startAt: Date, startTz: string | null, end: IcsTime | null): Date {
  const allDayEnd = () => agencyInstant(start.year, start.month, start.day + 1, 0, 0);
  let endAt: Date;
  if (end) endAt = instant(end, tzidOf(c, "dtend") ?? startTz);
  else endAt = start.isDate ? allDayEnd() : startAt;
  if (endAt.getTime() <= startAt.getTime() && start.isDate) endAt = allDayEnd();
  return endAt;
}

/** Runs `fn`, skipping an entry that cannot be read; only the file's limits stop the parse. */
function safely(fn: () => void): void {
  try {
    fn();
  } catch (err) {
    if (err instanceof CalendarLimitError) throw err;
    // An event that cannot be read is skipped, never fatal.
  }
}

/** Adds each occurrence of a recurring event before `to`. Occurrences before the window cost iterations but never rows. */
function expandMaster(ev: IcsEvent, to: Date, spend: () => void, add: (c: IcsComponent, title: string | null, start: IcsTime, end: IcsTime | null) => void): void {
  try {
    const it = ev.iterator();
    for (;;) {
      spend();
      const next = it.next();
      if (!next) break;
      if (instant(next, tzidOf(ev.component, "dtstart")).getTime() >= to.getTime()) break;
      safely(() => {
        const d = ev.getOccurrenceDetails(next);
        add(d.item.component, d.item.summary, d.startDate, d.endDate);
      });
    }
  } catch (err) {
    if (err instanceof CalendarLimitError) throw err;
  }
}

/**
 * Busy blocks from an ICS file inside [from, to): recurring events expanded, time zones honored, events marked
 * Free (TRANSP:TRANSPARENT) or cancelled skipped, and all-day events blocking the whole agency day. An event
 * that cannot be read (no start) is skipped. The whole file shares one iteration budget, a time budget and a
 * row cap; past them it throws CalendarLimitError. Titles are kept so the deputy can see what conflicts; they
 * stay private to the deputy.
 */
export function parseIcsBusy(ics: string, from: Date, to: Date): Busy[] {
  const root = readCalendar(ics);
  ICAL.TimezoneService.reset();
  for (const z of root.getAllSubcomponents("vtimezone")) ICAL.TimezoneService.register(z);

  const startedAt = performance.now();
  let iterations = 0;
  const spend = () => {
    iterations++;
    if (iterations > MAX_ITERATIONS || (iterations % 64 === 0 && performance.now() - startedAt > PARSE_BUDGET_MS)) {
      throw new CalendarLimitError("That calendar is too large.");
    }
  };

  const { singles, masters } = sortEvents(root, spend);

  const out: Busy[] = [];
  const add = (c: IcsComponent, title: string | null, start: IcsTime, end: IcsTime | null) => {
    if (isFree(c)) return;
    const startTz = tzidOf(c, "dtstart");
    const startAt = instant(start, startTz);
    const endAt = busyEnd(c, start, startAt, startTz, end);
    if (endAt.getTime() <= startAt.getTime()) return;
    if (startAt.getTime() >= to.getTime() || endAt.getTime() <= from.getTime()) return;
    if (out.length >= MAX_BUSY_ROWS) throw new CalendarLimitError("That calendar is too large.");
    out.push({ startAt, endAt, title: cleanTitle(title) });
  };

  for (const ev of singles) {
    spend();
    safely(() => add(ev.component, ev.summary, ev.startDate, ev.endDate));
  }
  for (const ev of masters.values()) expandMaster(ev, to, spend, add);
  return out.sort((a, b) => a.startAt.getTime() - b.startAt.getTime() || a.endAt.getTime() - b.endAt.getTime());
}

// ---------------------------------------------------------------- stored schedule (private to the owner)

/** Planning data belongs to one person: nobody else, coordinators and admins included, and never a vendor. */
export function assertOwn(actor: Actor, userId: string = actor.userId): void {
  assertCan(actor, "planning.manageOwn", { ownerUserId: userId });
  if (userId !== actor.userId) throw new ForbiddenError("Planning data is private to its owner.");
}

export type WorkScheduleInput = {
  kind: "weekly" | "rotation";
  weekdays?: number[];
  cycle?: string;
  anchorDate?: string;
  shiftStart: string;
  shiftEnd: string;
  bufferMinutes: number;
  active?: boolean;
};

export type StoredSchedule = typeof workSchedules.$inferSelect;

function validateSchedule(input: WorkScheduleInput): Pick<StoredSchedule, "kind" | "weekdays" | "cycle" | "anchorDate" | "shiftStart" | "shiftEnd" | "bufferMinutes" | "active"> {
  clock(input.shiftStart, "The shift start");
  clock(input.shiftEnd, "The shift end");
  validateBuffer(input.bufferMinutes);
  if (input.kind === "weekly") {
    const days = [...new Set(input.weekdays ?? [])];
    if (days.length === 0 || days.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) {
      throw new ValidationError("Choose at least one weekday, from Sunday (0) to Saturday (6).");
    }
    return { kind: "weekly", weekdays: days.toSorted((a, b) => a - b), cycle: null, anchorDate: input.anchorDate ?? "2026-01-01", shiftStart: input.shiftStart, shiftEnd: input.shiftEnd, bufferMinutes: input.bufferMinutes, active: input.active ?? true };
  }
  if (input.kind !== "rotation") throw new ValidationError("The schedule must be weekly or a rotation.");
  const cycle = input.cycle ?? "";
  if (!/^[01]{2,60}$/.test(cycle) || !cycle.includes("1")) {
    throw new ValidationError("The rotation cycle must be 2 to 60 days of 1 (works) and 0 (off), with at least one 1.");
  }
  if (!input.anchorDate) throw new ValidationError("A rotation needs the date its cycle starts.");
  dateParts(input.anchorDate);
  return { kind: "rotation", weekdays: null, cycle, anchorDate: input.anchorDate, shiftStart: input.shiftStart, shiftEnd: input.shiftEnd, bufferMinutes: input.bufferMinutes, active: input.active ?? true };
}

/** Replaces the person's schedule; null turns it off. The audit row names the action and the user only. */
export async function setWorkSchedule(actor: Actor, tx: Tx, input: WorkScheduleInput | null): Promise<StoredSchedule | null> {
  assertOwn(actor);
  const [existing] = await tx.select().from(workSchedules).where(eq(workSchedules.userId, actor.userId));
  let row: StoredSchedule | null;
  if (input === null) {
    if (!existing) return null;
    [row] = await tx.update(workSchedules).set({ active: false }).where(eq(workSchedules.id, existing.id)).returning();
  } else {
    const values = validateSchedule(input);
    [row] = await tx
      .insert(workSchedules)
      .values({ userId: actor.userId, ...values })
      .onConflictDoUpdate({ target: workSchedules.userId, set: { ...values, updatedAt: new Date() } })
      .returning();
  }
  await recordAudit(tx, { actor, action: "planning.schedule_set", entityType: "planning", entityId: actor.userId });
  return row;
}

export async function getWorkSchedule(actor: Actor, tx: Tx, userId: string): Promise<StoredSchedule | null> {
  assertOwn(actor, userId);
  const [row] = await tx.select().from(workSchedules).where(eq(workSchedules.userId, userId));
  return row ?? null;
}

export type ExceptionInput = { date: string; kind: "off" | "extra"; shiftStart?: string; shiftEnd?: string };

export async function addScheduleException(actor: Actor, tx: Tx, input: ExceptionInput): Promise<typeof scheduleExceptions.$inferSelect> {
  assertOwn(actor);
  dateParts(input.date);
  if (input.kind !== "off" && input.kind !== "extra") throw new ValidationError("An exception is a day off or an extra shift.");
  if (input.kind === "extra") {
    clock(input.shiftStart ?? null, "The shift start");
    clock(input.shiftEnd ?? null, "The shift end");
  }
  const [row] = await tx
    .insert(scheduleExceptions)
    .values({ userId: actor.userId, date: input.date, kind: input.kind, shiftStart: input.kind === "extra" ? input.shiftStart : null, shiftEnd: input.kind === "extra" ? input.shiftEnd : null })
    .returning();
  await recordAudit(tx, { actor, action: "planning.exception_add", entityType: "planning", entityId: actor.userId });
  return row;
}

/** Removes one of the owner's exceptions. Someone else's id is simply not found. */
export async function removeScheduleException(actor: Actor, tx: Tx, id: string): Promise<void> {
  assertOwn(actor);
  const removed = await tx.delete(scheduleExceptions).where(and(eq(scheduleExceptions.id, id), eq(scheduleExceptions.userId, actor.userId))).returning({ id: scheduleExceptions.id });
  if (removed.length === 0) throw new NotFoundError("Exception not found.");
  await recordAudit(tx, { actor, action: "planning.exception_remove", entityType: "planning", entityId: actor.userId });
}

export async function listScheduleExceptions(actor: Actor, tx: Tx, userId: string): Promise<Array<typeof scheduleExceptions.$inferSelect>> {
  assertOwn(actor, userId);
  return tx.select().from(scheduleExceptions).where(eq(scheduleExceptions.userId, userId)).orderBy(asc(scheduleExceptions.date), asc(scheduleExceptions.id));
}

async function loadScheduleRows(tx: Tx, userId: string) {
  const schedules = await tx.select().from(workSchedules).where(eq(workSchedules.userId, userId));
  const exceptions = await tx.select().from(scheduleExceptions).where(eq(scheduleExceptions.userId, userId));
  return { schedules, exceptions };
}

/** Calendar busy blocks overlapping [from, to) for the person's feed. */
async function loadCalendarBusy(tx: Tx, userId: string, from: Date, to: Date): Promise<Busy[]> {
  const rows = await tx
    .select({ startAt: calendarBusy.startAt, endAt: calendarBusy.endAt, title: calendarBusy.title })
    .from(calendarBusy)
    .innerJoin(calendarFeeds, eq(calendarFeeds.id, calendarBusy.feedId))
    .where(and(eq(calendarFeeds.userId, userId), lte(calendarBusy.startAt, to), gte(calendarBusy.endAt, from)))
    .orderBy(asc(calendarBusy.startAt));
  return rows;
}

/** Duty intervals (with buffer) plus imported calendar busy blocks: what a deputy cannot work. Internal use only. */
export async function loadDuty(tx: Tx, userId: string, from: Date, to: Date): Promise<Interval[]> {
  const { schedules, exceptions } = await loadScheduleRows(tx, userId);
  const duty = dutyIntervals(schedules, exceptions, from, to);
  const busy = await loadCalendarBusy(tx, userId, from, to);
  return [...duty, ...busy.map(({ startAt, endAt }) => ({ startAt, endAt }))];
}

/** Work-schedule shifts only (no buffers, no calendar events), for the hour caps when the agency counts schedules. */
export async function scheduleShiftsForCaps(tx: Tx, userId: string, from: Date, to: Date): Promise<Interval[]> {
  const { schedules, exceptions } = await loadScheduleRows(tx, userId);
  return dutyIntervals(
    schedules.map((s) => ({ ...s, bufferMinutes: 0 })),
    exceptions,
    from,
    to,
  );
}
