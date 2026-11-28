import { and, asc, eq, gt, inArray, lte } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import { assignments, detailReminderSends, jobPositions, jobSafety, jobs, positionTypes, users, vendorLocations, vendors } from "@/db/schema";
import { mapsUrls, type MapsApp } from "@/lib/maps";
import type { PlaceholderValues } from "../email-messages/placeholders";
import { emit } from "../notifications/notify";
import { scheduledPayCents } from "../planning/recommend";
import { getSettings, type AgencySettings } from "../settings/settings";
import { AGENCY_TZ } from "../time/agency-time";
import type { Cents } from "../types";
import { positionRateCents } from "./rate";
import { REMINDER_CHOICES } from "./reminder-choices";

/**
 * Detail reminders (owner request 2026-11-27): the people assigned to a detail are reminded at set times before it
 * starts, 72 and 24 hours by default. The agency sets the times; a detail can keep them, use its own or turn them off,
 * and add a note. Everyone on the detail when a reminder goes out gets it, people holding a spot they offered included;
 * backups do not. Someone assigned after a reminder went out does not get that one.
 */

type Job = typeof jobs.$inferSelect;

const HOUR_MS = 3_600_000;
/** The longest reminder time: details starting further out than this have nothing due. */
const LONGEST_MS = Math.max(...REMINDER_CHOICES) * HOUR_MS;

/** The reminder times a detail uses: its own, or the agency's when it has none. */
export function effectiveReminderHours(job: Pick<Job, "reminderHours">, settings: Pick<AgencySettings, "detailReminderHours">): number[] {
  return job.reminderHours ?? settings.detailReminderHours;
}

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, weekday: "short", month: "short", day: "numeric", year: "numeric" });
const TIME = new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, hour: "numeric", minute: "2-digit" });
const MONEY = (c: Cents) => (c % 100 === 0 ? `$${(c / 100).toLocaleString("en-US")}` : `$${(c / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);

/** "Thu, Dec 3, 2026". */
export const reminderDate = (d: Date) => DAY.format(d);
/** "5:00 PM to 11:00 PM". */
export const reminderTimes = (start: Date, end: Date) => `${TIME.format(start)} to ${TIME.format(end)}`;
/** "$280 at $70/hr". */
const payText = (total: Cents, rate: Cents) => `${MONEY(total)} at ${MONEY(rate)}/hr`;

/** What one person's reminder says: the short title and body (inbox and push) and the email's placeholder values. */
export type ReminderContent = { title: string; body: string; vars: PlaceholderValues };

/** Everything a reminder for this detail reads, loaded once for all its people. */
type ReminderFacts = {
  job: Job;
  vendorName: string;
  vendorMinimum: number | null;
  location: { name: string; address: string | null; lat: number | null; lng: number | null } | null;
  safetyNotes: string | null;
  settings: AgencySettings;
};

/** One person on the detail: their position and planned times, and their saved maps app. */
type ReminderPerson = { userId: string; name: string; maps: MapsApp | null; position: { name: string; rateDifferentialCents: Cents }; startAt: Date; endAt: Date };

/** The words of one person's reminder. Pure: the facts are loaded by the caller. */
export function reminderContent(f: ReminderFacts, p: ReminderPerson, hoursBefore: number): ReminderContent {
  const { job } = f;
  const day = reminderDate(p.startAt);
  const times = reminderTimes(p.startAt, p.endAt);
  const rate = positionRateCents(job.rateCents, p.position);
  const total = scheduledPayCents({ rateCents: rate, minimumBillableMinutes: job.minimumBillableMinutes }, f.vendorMinimum, f.settings, { startAt: p.startAt, endAt: p.endAt });
  const where = f.location ? [f.location.name, f.location.address].filter(Boolean).join(", ") : "No set location";
  const maps = f.location && (f.location.address || (f.location.lat !== null && f.location.lng !== null)) ? mapsUrls(f.location)[p.maps ?? "google"] : null;
  const contact = [job.contactName, job.contactPhone].filter(Boolean).join(", ");
  // The email is the agency's "Detail reminder" message (Management, Reminders and locks, Email messages).
  const vars: PlaceholderValues = {
    "detail.number": String(job.number),
    "detail.title": job.title,
    "detail.date": day,
    "detail.time": times,
    "detail.location": where,
    "detail.mapsLink": maps ?? "",
    "detail.description": job.description ?? "",
    "detail.position": p.position.name,
    "detail.pay": payText(total, rate),
    "detail.safety": f.safetyNotes ?? "",
    "detail.contact": contact,
    "reminder.hours": String(hoursBefore),
    "reminder.note": job.reminderNote ?? "",
    "vendor.name": f.vendorName,
  };
  return { title: `Reminder: #${job.number} ${job.title}`, body: `${day}, ${times}. ${where}.`, vars };
}

/** The detail's facts for its reminders. */
async function loadFacts(tx: Tx, job: Job, settings: AgencySettings): Promise<ReminderFacts> {
  const [vendor] = await tx.select({ name: vendors.name, minimum: vendors.minimumBillableMinutes }).from(vendors).where(eq(vendors.id, job.vendorId));
  const [location] = job.locationId
    ? await tx.select({ name: vendorLocations.name, address: vendorLocations.address, lat: vendorLocations.lat, lng: vendorLocations.lng }).from(vendorLocations).where(eq(vendorLocations.id, job.locationId))
    : [];
  const [safety] = await tx.select({ notes: jobSafety.notes }).from(jobSafety).where(eq(jobSafety.jobId, job.id));
  return { job, vendorName: vendor?.name ?? "", vendorMinimum: vendor?.minimum ?? null, location: location ?? null, safetyNotes: safety?.notes ?? null, settings };
}

/** Everyone on the detail now: signed up, a spot they offered included. Backups and pending shorter shifts are not. */
async function peopleOn(tx: Tx, job: Job): Promise<ReminderPerson[]> {
  const rows = await tx
    .select({
      userId: assignments.userId,
      name: users.name,
      active: users.active,
      maps: users.preferredMapsApp,
      positionName: positionTypes.name,
      differential: jobPositions.rateDifferentialCents,
      plannedStartAt: assignments.plannedStartAt,
      plannedEndAt: assignments.plannedEndAt,
    })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(and(eq(assignments.jobId, job.id), eq(assignments.status, "signed_up")))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
  return rows
    .filter((r) => r.active)
    .map((r) => ({
      userId: r.userId,
      name: r.name,
      maps: r.maps,
      position: { name: r.positionName, rateDifferentialCents: r.differential },
      startAt: r.plannedStartAt ?? job.startAt,
      endAt: r.plannedEndAt ?? job.endAt,
    }));
}

/**
 * Which reminder of this detail is due now, and the earlier due ones passed over: of the times whose due moment has
 * come (and came after the detail was made), the ones not yet sent for its current start. Only the latest is sent; a
 * worker that was down, or a detail moved earlier, never sends a burst of old reminders. A reminder counts as sent when
 * it went out at or after its due moment, so a time change that moves the due moment later arms it again.
 */
export function dueReminder(job: Pick<Job, "startAt" | "createdAt">, hours: readonly number[], sends: ReadonlyArray<{ hoursBefore: number; sentAt: Date }>, now: Date): { send: number; passed: number[] } | null {
  const open = hours
    .map((h) => ({ h, due: new Date(job.startAt.getTime() - h * HOUR_MS) }))
    .filter(({ h, due }) => due.getTime() <= now.getTime() && due.getTime() >= job.createdAt.getTime() && !sends.some((s) => s.hoursBefore === h && s.sentAt.getTime() >= due.getTime()))
    .map(({ h }) => h)
    .toSorted((a, b) => a - b);
  if (open.length === 0) return null;
  return { send: open[0], passed: open.slice(1) };
}

/** One detail's due reminder, in its own transaction with the detail locked. Returns the number of people reminded. */
async function remindOne(tx: Tx, jobId: string, now: Date): Promise<number> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job || job.held || (job.state !== "scheduled" && job.state !== "active") || job.startAt.getTime() <= now.getTime()) return 0;
  const settings = await getSettings(tx);
  const hours = effectiveReminderHours(job, settings);
  if (hours.length === 0) return 0;
  const sends = await tx.select({ hoursBefore: detailReminderSends.hoursBefore, sentAt: detailReminderSends.sentAt }).from(detailReminderSends).where(eq(detailReminderSends.jobId, job.id));
  const due = dueReminder(job, hours, sends, now);
  if (!due) return 0;
  const people = await peopleOn(tx, job);
  const slot = (h: number, sent: boolean) => ({ jobId: job.id, hoursBefore: h, dueAt: new Date(job.startAt.getTime() - h * HOUR_MS), sentAt: now, sent, recipients: sent ? people.length : 0 });
  // The unique slot keeps a second run from sending again; nothing is sent unless this run wrote it.
  const [mine] = await tx.insert(detailReminderSends).values(slot(due.send, true)).onConflictDoNothing().returning({ id: detailReminderSends.id });
  if (due.passed.length) await tx.insert(detailReminderSends).values(due.passed.map((h) => slot(h, false))).onConflictDoNothing();
  if (!mine || people.length === 0) return 0;
  const facts = await loadFacts(tx, job, settings);
  // Sequential: one alert per person (each has their own position, pay and maps link), in this transaction.
  for (const p of people) {
    const c = reminderContent(facts, p, due.send);
    await emit(tx, { type: "job.reminder", recipients: [p.userId], title: c.title, body: c.body, link: `/jobs/${job.id}`, vars: c.vars }, now);
  }
  return people.length;
}

/**
 * Scheduled tick: sends each detail's due reminder to the people on it. Canceled, held, requested and started details
 * get nothing. Each detail runs in its own transaction, so one failure is logged and skipped. Returns how many people
 * were reminded.
 */
export async function detailRemindersTick(now: Date = new Date()): Promise<number> {
  const due = await withTx((tx) =>
    tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(inArray(jobs.state, ["scheduled", "active"]), eq(jobs.held, false), gt(jobs.startAt, now), lte(jobs.startAt, new Date(now.getTime() + LONGEST_MS))))
      .orderBy(asc(jobs.startAt), asc(jobs.id)),
  );
  let reminded = 0;
  // Sequential: one locking transaction per detail.
  for (const { id } of due) {
    try {
      reminded += await withTx((tx) => remindOne(tx, id, now));
    } catch (err) {
      console.error(`Detail reminder failed for detail ${id}:`, err);
    }
  }
  return reminded;
}
