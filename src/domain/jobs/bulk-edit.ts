import { and, asc, eq, gte, inArray, notInArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobPositions, jobs, positionTypes, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { assertCan } from "../auth/policy";
import { DomainError, NotFoundError, ValidationError } from "../errors";
import { emit } from "../notifications/notify";
import { agencyDateParts, agencyInstant, AGENCY_TZ } from "../time/agency-time";
import type { Cents } from "../types";
import { isJobLocked } from "../vendor-portal/holds";
import { editOne, normalizeForEdit, type Job, type JobChange, type PositionInput } from "./jobs";
import { conflictFingerprint, ScheduleConflictError, type ScheduleConflict } from "./schedule-conflicts";

/**
 * Quick edit (one detail, or this and the later details of its series) and bulk edit (any details a coordinator
 * selects): the rate, start and end clock times, positions and description, in one save. A preview runs every
 * change in a savepoint that is rolled back, so it shows exactly what saving would do or refuse. Saving is
 * all-or-nothing, audited per detail, and the people on the changed details get one alert each.
 */

export type EditPatch = {
  /** Null uses the vendor's default. */
  rateCents?: Cents | null;
  /** "HH:MM" agency clock times applied on each detail's own date; an end at or before the start ends the next day. */
  startTime?: string;
  endTime?: string;
  positions?: PositionInput[];
  description?: string | null;
  /** Only for a single detail edited on its own. */
  rateOverrideReason?: string | null;
  /** A coordinator's override of the deputy conflicts the preview listed: a reason and each detail's fingerprint. */
  conflictOverride?: { reason: string; fingerprints: Record<string, string> } | null;
};

type EditSnapshot = { startAt: Date; endAt: Date; rateCents: Cents; description: string | null; positions: Array<{ name: string; count: number }> };
/** `conflicts`: deputies on the detail the new times would double-book or put over a cap. */
export type EditRow = { jobId: string; number: number; title: string; vendorName: string; before: EditSnapshot; after: EditSnapshot | null; problem: string | null; conflicts: ScheduleConflict[]; conflictFingerprint: string | null };

/** At most this many details in one bulk edit. */
const MAX_BULK_EDIT = 200;

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DAY = new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, weekday: "short", month: "short", day: "numeric" });

/** The detail's new start and end when the clock times change, on the agency date it starts. */
export function clockTimes(job: { startAt: Date; endAt: Date }, startTime?: string, endTime?: string): { startAt: Date; endAt: Date } {
  const p = agencyDateParts(job.startAt);
  const at = (t: string, plusDays = 0) => {
    const m = HHMM.exec(t);
    if (!m) throw new ValidationError("Enter times as HH:MM.");
    return agencyInstant(p.year, p.month, p.day + plusDays, Number(m[1]), Number(m[2]));
  };
  const startAt = startTime ? at(startTime) : job.startAt;
  if (!endTime) return { startAt, endAt: job.endAt };
  const sameDay = at(endTime);
  // An end at or before the start ends the next day; equal times make a 24-hour detail.
  return { startAt, endAt: sameDay.getTime() > startAt.getTime() ? sameDay : at(endTime, 1) };
}

class Rollback extends Error {}


function isEmpty(patch: EditPatch): boolean {
  return patch.rateCents === undefined && !patch.startTime && !patch.endTime && patch.positions === undefined && patch.description === undefined;
}

async function snapshot(tx: Tx, job: Job): Promise<EditSnapshot> {
  const rows = await tx
    .select({ name: positionTypes.name, count: jobPositions.count })
    .from(jobPositions)
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(eq(jobPositions.jobId, job.id))
    .orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  return { startAt: job.startAt, endAt: job.endAt, rateCents: job.rateCents, description: job.description, positions: rows };
}

async function loadTargets(tx: Tx, ids: string[]): Promise<Array<{ job: Job; vendorName: string }>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) throw new ValidationError("Choose at least one detail.");
  if (unique.length > MAX_BULK_EDIT) throw new ValidationError(`Edit at most ${MAX_BULK_EDIT} details at a time.`);
  const rows = await tx
    .select({ job: jobs, vendorName: vendors.name })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(inArray(jobs.id, unique))
    .orderBy(asc(jobs.startAt), asc(jobs.number))
    .for("update", { of: jobs });
  if (rows.length !== unique.length) throw new NotFoundError("Job not found.");
  return rows;
}

/** This detail and, for `series`, every later open detail in its series. */
export async function seriesIds(tx: Tx, id: string, scope: "one" | "series"): Promise<string[]> {
  const [first] = await tx.select().from(jobs).where(eq(jobs.id, id));
  if (!first) throw new NotFoundError("Job not found.");
  if (scope === "one" || !first.seriesId) return [first.id];
  const rows = await tx
    .select({ id: jobs.id })
    .from(jobs)
    .where(and(eq(jobs.seriesId, first.seriesId), gte(jobs.startAt, first.startAt), notInArray(jobs.state, ["canceled", "declined"])))
    .orderBy(asc(jobs.startAt), asc(jobs.id));
  return rows.map((r) => r.id);
}

/** Why no quick or bulk edit can change this detail at all (closed or started), or null. Screens show it before a save. */
export function editBlockReason(job: Pick<Job, "state" | "startAt">, now: Date): string | null {
  if (job.state === "canceled" || job.state === "declined") return "Canceled or declined details cannot be changed.";
  if (job.startAt.getTime() <= now.getTime()) return "This detail has started.";
  return null;
}

/** Why this detail cannot take the edit before any change is tried, or null. */
async function blocked(tx: Tx, job: Job, patch: EditPatch, now: Date): Promise<string | null> {
  const reason = editBlockReason(job, now);
  if (reason) return reason;
  if ((patch.rateCents !== undefined || patch.startTime || patch.endTime) && (await isJobLocked(tx, job.id))) return "Locked: the vendor is on payment hold.";
  return null;
}

function problemOf(e: unknown): string {
  if (e instanceof DomainError) {
    const checks = (e as { checks?: Array<{ ok: boolean; message: string }> }).checks;
    return checks?.length ? checks.filter((c) => !c.ok).map((c) => c.message).join(" ") : e.message;
  }
  throw e;
}

async function run(actor: Actor, tx: Tx, ids: string[], patch: EditPatch, now: Date, save: boolean): Promise<{ rows: EditRow[]; changes: JobChange[]; unresolved: boolean }> {
  if (isEmpty(patch)) throw new ValidationError("Change at least one thing.");
  const targets = await loadTargets(tx, ids);
  // Every detail must be the actor's to edit (a vendor manager: only their vendors' details).
  if (targets.length === 0) assertCan(actor, "job.update");
  for (const t of targets) assertCan(actor, "job.update", { vendorId: t.job.vendorId });
  const allowOverride = targets.length === 1;
  const normalized = await normalizeForEdit(tx, patch.positions);
  const rows: EditRow[] = [];
  const changes: JobChange[] = [];
  let unresolved = false;
  try {
    // Every detail is edited in save order inside one savepoint, so each is checked against the others' new times
    // exactly as the save does; a preview rolls the whole savepoint back at the end.
    await tx.transaction(async (all) => {
      // Sequential: each detail is edited in save order and checked against the ones before it.
      for (const { job, vendorName } of targets) {
        const before = await snapshot(all, job);
        const row: EditRow = { jobId: job.id, number: job.number, title: job.title, vendorName, before, after: null, problem: await blocked(all, job, patch, now), conflicts: [], conflictFingerprint: null };
        rows.push(row);
        if (row.problem) continue;
        try {
          // A refused detail rolls back only its own changes.
          await all.transaction(async (sp) => {
            const times = patch.startTime || patch.endTime ? clockTimes(job, patch.startTime, patch.endTime) : {};
            const r = await editOne(actor, sp, job, {
              ...times,
              ...(patch.rateCents !== undefined ? { rateCents: patch.rateCents } : {}),
              ...(patch.description !== undefined ? { description: patch.description } : {}),
              ...(allowOverride && patch.rateOverrideReason ? { rateOverrideReason: patch.rateOverrideReason } : {}),
              ...(save && patch.conflictOverride ? { conflictOverride: { reason: patch.conflictOverride.reason, fingerprint: patch.conflictOverride.fingerprints[job.id] ?? "" } } : {}),
            }, normalized, allowOverride ? "one" : "series");
            row.after = await snapshot(sp, r.job);
            row.conflicts = r.conflicts;
            row.conflictFingerprint = r.conflicts.length ? conflictFingerprint(r.conflicts) : null;
            if (!r.resolved) unresolved = true;
            if (r.change) changes.push(r.change);
          });
        } catch (e) {
          row.problem = problemOf(e);
        }
      }
      if (!save) throw new Rollback();
    });
  } catch (e) {
    if (!(e instanceof Rollback)) throw e;
  }
  return { rows, changes, unresolved };
}

/** What saving the edit would do to each detail, and why any would be refused. Nothing is written. */
export async function previewEdit(actor: Actor, tx: Tx, ids: string[], patch: EditPatch, now: Date = new Date()): Promise<EditRow[]> {
  return (await run(actor, tx, ids, patch, now, false)).rows;
}

/**
 * Saves the edit on every detail or on none: any refusal throws a ValidationError naming the details. People on
 * the changed details get one alert each that lists every one of their details that changed.
 */
export async function applyEdit(actor: Actor, tx: Tx, ids: string[], patch: EditPatch, now: Date = new Date()): Promise<EditRow[]> {
  const { rows, changes, unresolved } = await run(actor, tx, ids, patch, now, true);
  const refused = rows.filter((r) => r.problem);
  if (refused.length) {
    const reasons = refused.map((r) => `#${r.number} ${r.title}, ${DAY.format(r.before.startAt)}: ${r.problem}`).join(" ");
    throw new ValidationError(`Nothing was saved. ${reasons}`);
  }
  // Deputy conflicts not covered by a matching override refuse the whole save (the caller's transaction rolls back),
  // listing every conflict with the fingerprints the preview showed.
  if (unresolved) throw new ScheduleConflictError(rows.flatMap((r) => r.conflicts));
  const byPerson = new Map<string, JobChange[]>();
  for (const c of changes) for (const u of c.audience) byPerson.set(u, [...(byPerson.get(u) ?? []), c]);
  // Sequential: alert writes in this transaction.
  for (const [userId, list] of byPerson) {
    const one = list.length === 1;
    await emit(tx, {
      recipients: [userId],
      type: "job.changed",
      title: one ? `Detail changed: #${list[0].number} ${list[0].title}` : `${list.length} of your details changed`,
      body: one ? list[0].details.join(" ") : list.map((c) => `#${c.number} ${c.title}, ${DAY.format(c.startAt)}: ${c.details.join(" ")}`).join("\n"),
      link: one ? `/jobs/${list[0].jobId}` : "/calendar?mine=1",
    });
  }
  return rows;
}
