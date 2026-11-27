import { and, asc, desc, eq, getTableColumns, gt, gte, ilike, inArray, isNull, lt, lte, notInArray, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, auditLog, hiddenVendors, invoices, jobAttachments, jobPositions, jobs, jobTypes, positionTypes, qualifications, ranks, vendorLocations, users, vendorRestrictions, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { jobAudience, vendorAudience } from "../notifications/audiences";
import { emit } from "../notifications/notify";
import { assertCan, managesVendor } from "../auth/policy";
import { jobVendorId } from "../auth/scope";
import { NotFoundError, RuleViolation, ValidationError } from "../errors";
import { cleanChangedContactName, cleanContactName } from "../contact-name";
import { cleanChangedPhone, cleanPhone } from "../phone";
import { fitsSchedule, loadDuty } from "../planning/schedule";
import { releaseAt, restoredReleaseAt, type JobState } from "../release/release";
import { getSettings, type AgencySettings } from "../settings/settings";
import { AGENCY_TZ } from "../time/agency-time";
import type { Cents } from "../types";
import { type ContractStatus, jobContractStatus } from "./contract-status";
import { outsideRange, rateRangeMessage, resolveRate } from "./rate";
import { isJobLocked, openHold } from "../vendor-portal/holds";
import { LATE_CANCEL_VOID_ACTION } from "../assignments/history";
import { applySafety, loadSafety, type JobSafetyView, type SafetyInput } from "./safety";
import { conflictsAt, overrideReason, ScheduleConflictError, type ConflictOverride, type ScheduleConflict } from "./schedule-conflicts";

export type Job = typeof jobs.$inferSelect;
type JobPosition = typeof jobPositions.$inferSelect;
export type JobAttachment = typeof jobAttachments.$inferSelect;

export type PositionInput = {
  positionTypeId: string;
  count: number;
  eligibleRankIdsOverride?: string[];
  requiredQualificationIdsOverride?: string[];
};

export type JobInput = {
  vendorId: string;
  locationId: string | null;
  typeId: string;
  title: string;
  description: string | null;
  notes: string | null;
  startAt: Date;
  endAt: Date;
  rateCents: Cents | null;
  positions?: PositionInput[];
  opsPlanRequired: boolean;
  opsPlanDueAt: Date | null;
  contactName: string | null;
  contactPhone: string | null;
  held: boolean;
  flex?: { earliestStartAt: Date; latestEndAt: Date; allowShorter: boolean } | null;
  safety?: SafetyInput;
  /**
   * A coordinator's or admin's reason for a rate outside the agency range, for this one detail. Ignored for
   * vendors, series edits, copies and bulk dates.
   */
  rateOverrideReason?: string | null;
  /**
   * A coordinator's override to save a time change although it double-books a deputy on the detail or breaks their
   * hour caps: a reason and the fingerprint of the conflicts they were shown. Ignored for anyone who cannot
   * override, and refused when the conflicts are not the ones shown.
   */
  conflictOverride?: ConflictOverride | null;
};

export const JOBS_PAGE_SIZE = 50;
/** The widest range "only details I can work" will filter, since it reads every job in the range. */
const MAX_WORKABLE_RANGE_DAYS = 400;

const text = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);
const money = (c: Cents) => `$${Math.floor(c / 100)}.${String(c % 100).padStart(2, "0")}`;
const when = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, dateStyle: "medium", timeStyle: "short" }).format(d);
const sameList = (a: string[] | null, b: string[] | null) => JSON.stringify(a) === JSON.stringify(b);

/** People holding a spot or place in line: anything not canceled or removed. */
async function signupCount(tx: Tx, jobId: string): Promise<number> {
  const rows = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobId, jobId), notInArray(assignments.status, ["canceled", "removed"])));
  return rows.length;
}

async function getRow(tx: Tx, id: string): Promise<Job> {
  const [row] = await tx.select().from(jobs).where(eq(jobs.id, id));
  if (!row) throw new NotFoundError("Job not found.");
  return row;
}

function assertTimes(startAt: Date, endAt: Date, flex: { earliestStartAt: Date | null; latestEndAt: Date | null } | null): void {
  if (!(startAt instanceof Date) || Number.isNaN(startAt.getTime()) || !(endAt instanceof Date) || Number.isNaN(endAt.getTime())) {
    throw new ValidationError("Start and end times are required.");
  }
  if (endAt.getTime() <= startAt.getTime()) throw new ValidationError("The end time must be after the start time.");
  if (flex?.earliestStartAt && flex.earliestStartAt.getTime() > startAt.getTime()) {
    throw new ValidationError("The earliest flexible start cannot be after the start time.");
  }
  if (flex?.latestEndAt && flex.latestEndAt.getTime() < endAt.getTime()) {
    throw new ValidationError("The latest flexible end cannot be before the end time.");
  }
}

function assertRate(rate: Cents): void {
  if (!Number.isInteger(rate) || rate <= 0) throw new ValidationError("The hourly rate must be a whole number of cents greater than zero.");
}

/**
 * The override to store when `rate` is outside the agency range, or null when it is inside. Out of range is
 * refused unless a coordinator or admin gives a reason and `allowOverride` (one detail, not a series, copy, bulk
 * or vendor path).
 */
function rangeOverride(actor: Actor, rate: Cents, settings: AgencySettings, reason: string | null | undefined, allowOverride: boolean, label = ""): { rateOverrideReason: string; rateOverrideBy: string; rateOverrideAt: Date } | null {
  if (!outsideRange(rate, settings)) return null;
  const why = reason?.trim();
  if (why && why.length > MAX_OVERRIDE_REASON) throw new ValidationError(`Keep the reason to ${MAX_OVERRIDE_REASON} characters.`);
  if (why && allowOverride && (actor.role === "coordinator" || actor.role === "admin")) return { rateOverrideReason: why, rateOverrideBy: actor.userId, rateOverrideAt: new Date() };
  throw new ValidationError(`${label}${rateRangeMessage(settings)}.`);
}

const MAX_OVERRIDE_REASON = 500;

const NO_OVERRIDE = { rateOverrideReason: null, rateOverrideBy: null, rateOverrideAt: null } as const;

type Normalized = Omit<PositionInput, "eligibleRankIdsOverride" | "requiredQualificationIdsOverride"> & {
  eligibleRankIdsOverride: string[] | null;
  requiredQualificationIdsOverride: string[] | null;
  /** The type's differential now; snapshotted only when the position is added. */
  rateDifferentialCents: Cents;
};

/** The ids without repeats, after checking each exists (`find` returns the ones found); null stays null. */
async function existingIds(ids: string[] | null | undefined, find: (ids: string[]) => Promise<unknown[]>, missing: string): Promise<string[] | null> {
  if (!ids) return null;
  const unique = [...new Set(ids)];
  const found = unique.length ? await find(unique) : [];
  if (found.length !== unique.length) throw new ValidationError(missing);
  return unique;
}

async function normalizePosition(tx: Tx, p: PositionInput): Promise<Normalized> {
  if (!Number.isInteger(p.count) || p.count < 1) throw new ValidationError("Each position needs a count of at least 1.");
  const [pt] = await tx
    .select({ id: positionTypes.id, active: positionTypes.active, differential: positionTypes.rateDifferentialCents })
    .from(positionTypes)
    .where(eq(positionTypes.id, p.positionTypeId));
  if (!pt?.active) throw new ValidationError("Position type not found.");
  const rankIds = await existingIds(p.eligibleRankIdsOverride, (ids) => tx.select({ id: ranks.id }).from(ranks).where(inArray(ranks.id, ids)), "An eligible rank was not found.");
  const qualIds = await existingIds(
    p.requiredQualificationIdsOverride,
    (ids) => tx.select({ id: qualifications.id }).from(qualifications).where(inArray(qualifications.id, ids)),
    "A required qualification was not found.",
  );
  return { positionTypeId: p.positionTypeId, count: p.count, eligibleRankIdsOverride: rankIds, requiredQualificationIdsOverride: qualIds, rateDifferentialCents: pt.differential };
}

async function normalizePositions(tx: Tx, given: PositionInput[], settings: AgencySettings): Promise<Normalized[]> {
  let list = given;
  if (list.length === 0) {
    if (!settings.defaultPositionTypeId) throw new ValidationError("Add at least one position; no default position type is set.");
    list = [{ positionTypeId: settings.defaultPositionTypeId, count: 1 }];
  }
  const out: Normalized[] = [];
  // Sequential: one transaction's queries, and the first invalid position is the one reported.
  for (const p of list) out.push(await normalizePosition(tx, p));
  return out;
}

async function assertRefs(tx: Tx, vendorId: string, locationId: string | null, typeId: string | null, requireActiveVendor = true): Promise<typeof vendors.$inferSelect> {
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, vendorId));
  if (!vendor) throw new ValidationError("Vendor not found.");
  if (requireActiveVendor && !vendor.active) throw new ValidationError("That vendor is inactive.");
  if (locationId) {
    const [loc] = await tx.select().from(vendorLocations).where(eq(vendorLocations.id, locationId));
    if (loc?.vendorId !== vendorId) throw new ValidationError("Location not found for this vendor.");
    if (!loc.active) throw new ValidationError("That location is inactive.");
  }
  if (typeId) {
    const [type] = await tx.select({ id: jobTypes.id, active: jobTypes.active }).from(jobTypes).where(eq(jobTypes.id, typeId));
    if (!type?.active) throw new ValidationError("Job type not found.");
  }
  return vendor;
}

function opsDue(required: boolean, due: Date | null, startAt: Date, hours: number): Date | null {
  if (!required) return null;
  return due ?? new Date(startAt.getTime() - hours * 3_600_000);
}

export async function createJob(actor: Actor, tx: Tx, input: JobInput): Promise<Job> {
  return createJobInSeries(actor, tx, input, null);
}

/** For vendor requests: the caller has authorized the actor, and the job starts `requested` for a coordinator's decision. */
export type CreateOptions = { authorized?: boolean; state?: "requested"; requestedByUserId?: string };

/** createJob's body, shared with bulk creation, which puts every job in one series. */
export async function createJobInSeries(actor: Actor, tx: Tx, input: JobInput, seriesId: string | null, opts: CreateOptions = {}): Promise<Job> {
  if (!opts.authorized) assertCan(actor, "job.create", { vendorId: input.vendorId });
  const title = input.title?.trim();
  if (!title) throw new ValidationError("A title is required.");
  const settings = await getSettings(tx);
  const vendor = await assertRefs(tx, input.vendorId, input.locationId, input.typeId);
  assertTimes(input.startAt, input.endAt, input.flex ? input.flex : null);
  const rate = resolveRate(input.rateCents, vendor.defaultRateCents, settings.agencyDefaultRateCents);
  assertRate(rate);
  // Only a single detail made by a coordinator or admin may carry an override; a series, copy or vendor request never does.
  const override = rangeOverride(actor, rate, settings, input.rateOverrideReason, seriesId === null && !opts.authorized && !opts.state);
  const positions = await normalizePositions(tx, input.positions ?? [], settings);

  const [row] = await tx
    .insert(jobs)
    .values({
      vendorId: input.vendorId,
      locationId: input.locationId,
      typeId: input.typeId,
      seriesId,
      title,
      description: text(input.description),
      notes: text(input.notes),
      startAt: input.startAt,
      endAt: input.endAt,
      rateCents: rate,
      ...(override ?? NO_OVERRIDE),
      minimumBillableMinutes: vendor.minimumBillableMinutes,
      flexEarliestStartAt: input.flex?.earliestStartAt ?? null,
      flexLatestEndAt: input.flex?.latestEndAt ?? null,
      flexAllowShorter: input.flex?.allowShorter ?? false,
      opsPlanRequired: input.opsPlanRequired,
      opsPlanDueAt: opsDue(input.opsPlanRequired, input.opsPlanDueAt, input.startAt, settings.opsPlanDefaultDueHours),
      contactName: cleanContactName(input.contactName),
      contactPhone: cleanPhone(input.contactPhone),
      state: opts.state ?? "scheduled",
      requestedByUserId: opts.requestedByUserId ?? null,
      held: input.held,
      releaseAt: releaseAt(input.startAt, settings),
    })
    .returning();
  await tx.insert(jobPositions).values(positions.map((p) => ({ jobId: row.id, ...p })));
  if (input.safety) await applySafety(actor, tx, row.id, input.safety);
  await recordAudit(tx, { actor, action: "job.create", entityType: "job", entityId: row.id, before: null, after: { ...row, positions } });
  if (override) {
    await recordAudit(tx, { actor, action: "job.rate_override", entityType: "job", entityId: row.id, before: null, after: { rateCents: rate, ...override }, reason: override.rateOverrideReason });
  }
  return row;
}

async function syncPositions(tx: Tx, jobId: string, wanted: Normalized[]): Promise<boolean> {
  const existing = await tx.select().from(jobPositions).where(eq(jobPositions.jobId, jobId)).orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const held = await tx
    .select({ positionId: assignments.jobPositionId })
    .from(assignments)
    .where(and(eq(assignments.jobId, jobId), notInArray(assignments.status, ["canceled", "removed"])));
  const used = new Map<string, number>();
  for (const h of held) used.set(h.positionId, (used.get(h.positionId) ?? 0) + 1);

  const claimed = new Set<string>();
  const plan = wanted.map((w) => {
    const match = existing.find((e) => !claimed.has(e.id) && e.positionTypeId === w.positionTypeId);
    if (match) claimed.add(match.id);
    return { w, match };
  });
  for (const e of existing) {
    if (!claimed.has(e.id) && (used.get(e.id) ?? 0) > 0) throw new ValidationError("A position with sign-ups cannot be removed.");
  }
  for (const { w, match } of plan) {
    if (match && w.count < (used.get(match.id) ?? 0)) throw new ValidationError("A position cannot hold fewer spots than it has sign-ups.");
  }

  let changed = false;
  // Sequential: position writes in this transaction, in plan order.
  for (const { w, match } of plan) {
    if (!match) {
      await tx.insert(jobPositions).values({ jobId, ...w });
      changed = true;
    } else if (
      match.count !== w.count ||
      !sameList(match.eligibleRankIdsOverride, w.eligibleRankIdsOverride) ||
      !sameList(match.requiredQualificationIdsOverride, w.requiredQualificationIdsOverride)
    ) {
      await tx
        .update(jobPositions)
        .set({ count: w.count, eligibleRankIdsOverride: w.eligibleRankIdsOverride, requiredQualificationIdsOverride: w.requiredQualificationIdsOverride })
        .where(eq(jobPositions.id, match.id));
      changed = true;
    }
  }
  const gone = existing.filter((e) => !claimed.has(e.id)).map((e) => e.id);
  if (gone.length) {
    await tx.delete(jobPositions).where(inArray(jobPositions.id, gone));
    changed = true;
  }
  return changed;
}

/** A saved change that the people on a detail are told about; bulk edits gather them into one alert per person. */
export type JobChange = { jobId: string; number: number; title: string; startAt: Date; details: string[]; audience: string[] };

/** Positions for quickEdit and bulk edit, checked once for every detail. */
export async function normalizeForEdit(tx: Tx, positions: PositionInput[] | undefined): Promise<Normalized[] | null> {
  if (!positions) return null;
  if (positions.length === 0) throw new ValidationError("Add at least one position.");
  return normalizePositions(tx, positions, await getSettings(tx));
}

/**
 * One detail's edit for quick and bulk edit: the same rules, audit rows and safety handling as updateJob, but the
 * time-or-rate alert is returned instead of sent, so the caller can send one alert per person.
 */
export async function editOne(actor: Actor, tx: Tx, before: Job, patch: Partial<JobInput>, positions: Normalized[] | null, scope: "one" | "series"): Promise<{ job: Job; change: JobChange | null; conflicts: ScheduleConflict[]; resolved: boolean }> {
  assertCan(actor, "job.update", { vendorId: before.vendorId });
  let change: JobChange | null = null;
  let conflicts: ScheduleConflict[] = [];
  let resolved = true;
  const job = await updateOne(
    actor,
    tx,
    before,
    patch,
    await getSettings(tx),
    positions,
    scope,
    (c) => {
      change = c;
    },
    (c, ok) => {
      conflicts = c;
      resolved = ok;
    },
    true,
  );
  return { job, change, conflicts, resolved };
}

/** The flexible window after an edit: unchanged when the patch leaves it out, cleared when the patch sets none. */
function patchedFlex(flex: JobInput["flex"], before: Job) {
  if (flex === undefined) return { earliestStartAt: before.flexEarliestStartAt, latestEndAt: before.flexLatestEndAt, allowShorter: before.flexAllowShorter };
  return flex ?? { earliestStartAt: null, latestEndAt: null, allowShorter: false };
}

type JobSet = Partial<typeof jobs.$inferInsert>;
type Flex = ReturnType<typeof patchedFlex>;

/** The text and flag columns an edit sets directly. */
function setPlainFields(set: JobSet, patch: Partial<JobInput>, before: Job): void {
  if (patch.locationId !== undefined) set.locationId = patch.locationId;
  if (patch.typeId !== undefined) set.typeId = patch.typeId;
  if (patch.title !== undefined) {
    const t = patch.title.trim();
    if (!t) throw new ValidationError("A title is required.");
    set.title = t;
  }
  if (patch.description !== undefined) set.description = text(patch.description);
  if (patch.notes !== undefined) set.notes = text(patch.notes);
  if (patch.contactName !== undefined) set.contactName = cleanChangedContactName(patch.contactName, before.contactName);
  if (patch.contactPhone !== undefined) set.contactPhone = cleanChangedPhone(patch.contactPhone, before.contactPhone);
  if (patch.held !== undefined) set.held = patch.held;
}

/** The time columns an edit sets: the times, the release date that follows the start, the flexible window and the ops plan due date. */
function setScheduleFields(set: JobSet, patch: Partial<JobInput>, before: Job, next: { startAt: Date; endAt: Date; flex: Flex }, settings: AgencySettings): void {
  const { startAt, endAt, flex } = next;
  if (patch.startAt !== undefined || patch.endAt !== undefined) {
    set.startAt = startAt;
    set.endAt = endAt;
  }
  // A new start follows the month rule only while the detail is not yet released: a release that already
  // happened (on schedule or by Release now) is never taken back by a time edit.
  const alreadyReleased = before.releaseAt !== null && before.releaseAt.getTime() <= Date.now();
  if (patch.startAt !== undefined && patch.startAt.getTime() !== before.startAt.getTime() && !alreadyReleased) set.releaseAt = releaseAt(startAt, settings);
  if (patch.flex !== undefined) {
    set.flexEarliestStartAt = flex.earliestStartAt;
    set.flexLatestEndAt = flex.latestEndAt;
    set.flexAllowShorter = flex.allowShorter;
  }
  const opsRequired = patch.opsPlanRequired ?? before.opsPlanRequired;
  if (patch.opsPlanRequired !== undefined || patch.opsPlanDueAt !== undefined) {
    const due = patch.opsPlanDueAt !== undefined ? patch.opsPlanDueAt : before.opsPlanDueAt;
    set.opsPlanRequired = opsRequired;
    set.opsPlanDueAt = opsDue(opsRequired, due, startAt, settings.opsPlanDefaultDueHours);
  }
}

/**
 * The rate columns an edit sets, and whether the rate changed. A rate that did not change keeps its standing (old
 * details outside a new range keep their pay). A new rate outside the range needs an override reason on this one
 * detail; one back inside the range drops the override.
 */
function setRateFields(
  actor: Actor,
  set: JobSet,
  patch: Partial<JobInput>,
  before: Job,
  ctx: { vendor: typeof vendors.$inferSelect; settings: AgencySettings; scope: "one" | "series"; collecting: boolean },
): boolean {
  const { vendor, settings, scope } = ctx;
  let rateChanged = false;
  const finalRate = patch.rateCents !== undefined ? resolveRate(patch.rateCents, vendor.defaultRateCents, settings.agencyDefaultRateCents) : before.rateCents;
  if (patch.rateCents !== undefined) {
    assertRate(finalRate);
    if (finalRate !== before.rateCents) {
      set.rateCents = finalRate;
      rateChanged = true;
    }
  }
  const reason = scope === "one" ? patch.rateOverrideReason : undefined;
  if (rateChanged || (reason?.trim() && !before.rateOverrideReason)) {
    // Quick and bulk edit show each refusal on the detail's own row, so it needs no label there.
    const label = scope === "series" && !ctx.collecting ? `${before.title}, ${when(before.startAt)}: ` : "";
    const override = rangeOverride(actor, finalRate, settings, reason, scope === "one", label);
    if (override) Object.assign(set, override);
    else if (before.rateOverrideReason) Object.assign(set, NO_OVERRIDE);
  }
  return rateChanged;
}

/** Deputies on the detail the new times or window conflict with: their other details and their caps. None when neither changed. */
async function editConflicts(tx: Tx, patch: Partial<JobInput>, before: Job, next: { startAt: Date; endAt: Date; flex: Flex }, settings: AgencySettings): Promise<ScheduleConflict[]> {
  const { startAt, endAt, flex } = next;
  const timesChanged = startAt.getTime() !== before.startAt.getTime() || endAt.getTime() !== before.endAt.getTime();
  const windowChanged =
    patch.flex !== undefined &&
    (flex.earliestStartAt?.getTime() !== before.flexEarliestStartAt?.getTime() || flex.latestEndAt?.getTime() !== before.flexLatestEndAt?.getTime());
  if (!timesChanged && !windowChanged) return [];
  return conflictsAt(tx, { ...before, startAt, endAt, flexEarliestStartAt: flex.earliestStartAt, flexLatestEndAt: flex.latestEndAt }, settings, new Date());
}

/**
 * A fixed-time detail carries everyone's planned times with it, so billing, calendars, the .ics feed and later
 * checks use the new times. A flexible detail keeps each person's own planned shift.
 */
async function carryPlannedTimes(tx: Tx, before: Job, after: Job, flex: Flex, timesChanged: boolean): Promise<void> {
  const fixedAfter = !(flex.earliestStartAt && flex.latestEndAt);
  // Turning a flexible detail into a fixed one does the same even with the times unchanged: no partial shift stays.
  const becameFixed = fixedAfter && before.flexEarliestStartAt !== null && before.flexLatestEndAt !== null;
  if ((timesChanged || becameFixed) && fixedAfter) {
    await tx
      .update(assignments)
      .set({ plannedStartAt: after.startAt, plannedEndAt: after.endAt })
      .where(and(eq(assignments.jobId, before.id), inArray(assignments.status, ["signed_up", "pending_short", "backup"])));
  }
}

const positionRows = (tx: Tx, jobId: string) => tx.select().from(jobPositions).where(eq(jobPositions.jobId, jobId)).orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));

/** The rate override audit rows: set or cleared, and a changed rate on a detail people signed up for. */
async function auditRate(actor: Actor, tx: Tx, before: Job, after: Job, rateChanged: boolean, hasSignups: boolean): Promise<void> {
  if (after.rateOverrideReason !== before.rateOverrideReason || after.rateOverrideAt?.getTime() !== before.rateOverrideAt?.getTime()) {
    const pick = (j: Job) => ({ rateCents: j.rateCents, rateOverrideReason: j.rateOverrideReason, rateOverrideBy: j.rateOverrideBy, rateOverrideAt: j.rateOverrideAt });
    await recordAudit(tx, { actor, action: after.rateOverrideReason ? "job.rate_override" : "job.rate_override_cleared", entityType: "job", entityId: before.id, before: pick(before), after: pick(after), reason: after.rateOverrideReason ?? undefined });
  }
  if (rateChanged && hasSignups) {
    await recordAudit(tx, {
      actor,
      action: "job.rate_changed",
      entityType: "job",
      entityId: before.id,
      before: { rateCents: before.rateCents },
      after: { rateCents: after.rateCents },
    });
  }
}

/** The lines of the change alert. Quick and bulk edit (collecting) also tell people when the positions or description changed. */
function changeDetails(before: Job, after: Job, rateChanged: boolean, positionsChanged: boolean, collecting: boolean): string[] {
  const details: string[] = [];
  if (rateChanged) details.push(`The hourly rate changed from ${money(before.rateCents)} to ${money(after.rateCents)}.`);
  if (after.startAt.getTime() !== before.startAt.getTime() || after.endAt.getTime() !== before.endAt.getTime()) {
    details.push(`The time changed to ${when(after.startAt)} to ${when(after.endAt)}.`);
  }
  if (after.locationId !== before.locationId) details.push("The location changed.");
  if (collecting && positionsChanged) details.push("The positions changed.");
  if (collecting && after.description !== before.description) details.push("The description changed.");
  return details;
}

/** The job's vendor, after checking a new location or type. */
function assertEditRefs(tx: Tx, before: Job, patch: Partial<JobInput>): Promise<typeof vendors.$inferSelect> {
  // Only a changed type or location is re-validated, so a deactivated type never blocks edits to its existing jobs.
  const newLocation = patch.locationId && patch.locationId !== before.locationId ? patch.locationId : null;
  const newType = patch.typeId && patch.typeId !== before.typeId ? patch.typeId : null;
  return assertRefs(tx, before.vendorId, newLocation, newType, false);
}

function assertJobEditable(before: Job, patch: Partial<JobInput>): void {
  if (before.state === "canceled" || before.state === "declined") throw new ValidationError("A canceled or declined job cannot be changed.");
  if (patch.vendorId !== undefined && patch.vendorId !== before.vendorId) throw new ValidationError("A job cannot move to another vendor.");
}

async function auditConflictOverride(actor: Actor, tx: Tx, before: Job, after: Job, conflicts: ScheduleConflict[], reason: string): Promise<void> {
  await recordAudit(tx, {
    actor,
    action: "job.schedule_conflict_override",
    entityType: "job",
    entityId: before.id,
    before: { startAt: before.startAt, endAt: before.endAt },
    after: { startAt: after.startAt, endAt: after.endAt, conflicts: conflicts.map((c) => ({ userId: c.userId, name: c.name, check: c.check, message: c.message })) },
    reason,
  });
}

/** The job.update audit row; with `positionsBefore` (the positions changed) both sides also list the positions. */
async function auditJobUpdate(actor: Actor, tx: Tx, before: Job, after: Job, positionsBefore: Array<typeof jobPositions.$inferSelect> | null): Promise<void> {
  const positionsAfter = positionsBefore ? await positionRows(tx, before.id) : null;
  await recordAudit(tx, {
    actor,
    action: "job.update",
    entityType: "job",
    entityId: before.id,
    before: positionsBefore ? { ...before, positions: positionsBefore } : before,
    after: positionsBefore ? { ...after, positions: positionsAfter } : after,
  });
}

/**
 * Alerts go to the people on the job (spec 14); the vendor and coordinators made the edit and are not alerted. Quick
 * and bulk edit collect the alert instead, so the caller sends one per person.
 */
async function alertChange(tx: Tx, before: Job, after: Job, details: string[], collect: ((c: JobChange) => void) | undefined): Promise<void> {
  if (!details.length) return;
  if (collect) {
    collect({ jobId: before.id, number: after.number, title: after.title, startAt: after.startAt, details, audience: await jobAudience(tx, after) });
    return;
  }
  await emit(tx, { recipients: await jobAudience(tx, after), type: "job.changed", title: `Detail changed: #${after.number} ${after.title}`, body: details.join(" "), link: `/jobs/${before.id}` });
}

/** Saves the safety change; when it changed anything, audits it (if people signed up) and alerts the people on the job. */
async function applySafetyEdit(actor: Actor, tx: Tx, before: Job, after: Job, safety: NonNullable<JobInput["safety"]>, hasSignups: boolean): Promise<void> {
  const changed = await applySafety(actor, tx, before.id, safety);
  if (changed && hasSignups) {
    await recordAudit(tx, { actor, action: "job.safety_changed", entityType: "job", entityId: before.id });
  }
  if (changed) {
    await emit(tx, {
      recipients: await jobAudience(tx, after),
      type: "job.safety_changed",
      title: `Officer safety information changed: #${after.number} ${after.title}`,
      body: "Review the officer safety notes and addresses before the detail.",
      link: `/jobs/${before.id}`,
    });
  }
}

async function updateOne(
  actor: Actor,
  tx: Tx,
  before: Job,
  patch: Partial<JobInput>,
  settings: AgencySettings,
  positions: Normalized[] | null,
  scope: "one" | "series",
  collect?: (c: JobChange) => void,
  onConflicts?: (c: ScheduleConflict[], resolved: boolean) => void,
  /**
   * Quick and bulk edit: never throw on deputy conflicts; save past them and report whether a valid override covered
   * them, so the caller checks every detail in save order and refuses the whole edit (rolling it back) if any is
   * unresolved. Never set from a client.
   */
  collectConflicts = false,
): Promise<Job> {
  assertJobEditable(before, patch);

  const vendor = await assertEditRefs(tx, before, patch);
  const startAt = patch.startAt ?? before.startAt;
  const endAt = patch.endAt ?? before.endAt;
  const flex = patchedFlex(patch.flex, before);
  assertTimes(startAt, endAt, flex);
  const next = { startAt, endAt, flex };

  const set: JobSet = {};
  setPlainFields(set, patch, before);
  setScheduleFields(set, patch, before, next, settings);
  const rateChanged = setRateFields(actor, set, patch, before, { vendor, settings, scope, collecting: Boolean(collect) });

  // New times are checked against every deputy holding a spot: overlap with their other details and their caps.
  const conflicts = await editConflicts(tx, patch, before, next, settings);
  const conflictReason = conflicts.length ? overrideReason(actor, before.vendorId, conflicts, patch.conflictOverride) : null;
  onConflicts?.(conflicts, !conflicts.length || !!conflictReason);
  if (conflicts.length && !conflictReason && !collectConflicts) throw new ScheduleConflictError(conflicts);

  let after = before;
  if (Object.keys(set).length) {
    [after] = await tx.update(jobs).set(set).where(eq(jobs.id, before.id)).returning();
  }
  const timesChanged = startAt.getTime() !== before.startAt.getTime() || endAt.getTime() !== before.endAt.getTime();
  await carryPlannedTimes(tx, before, after, flex, timesChanged);
  if (conflictReason) await auditConflictOverride(actor, tx, before, after, conflicts, conflictReason);
  const positionsBefore = positions ? await positionRows(tx, before.id) : null;
  const positionsChanged = positions ? await syncPositions(tx, before.id, positions) : false;
  const hasSignups = (rateChanged || patch.safety) && (await signupCount(tx, before.id)) > 0;

  if (Object.keys(set).length || positionsChanged) await auditJobUpdate(actor, tx, before, after, positionsChanged ? positionsBefore : null);
  await auditRate(actor, tx, before, after, rateChanged, Boolean(hasSignups));
  await alertChange(tx, before, after, changeDetails(before, after, rateChanged, positionsChanged, Boolean(collect)), collect);
  if (patch.safety) await applySafetyEdit(actor, tx, before, after, patch.safety, Boolean(hasSignups));
  return after;
}

/**
 * `scope` 'series' applies the patch to this job and every later, non-canceled job
 * in the same series; times cannot be changed that way. Rate and safety changes on
 * a job with sign-ups write audit rows. A change to the rate, times, location or officer safety alerts the job's audience.
 */
export async function updateJob(actor: Actor, tx: Tx, id: string, patch: Partial<JobInput>, scope: "one" | "series"): Promise<Job[]> {
  assertCan(actor, "job.update", { vendorId: await jobVendorId(tx, id) });
  return updateJobUnchecked(actor, tx, id, patch, scope);
}

/** updateJob without the policy check, for services that have authorized the actor themselves (vendor portal). */
export async function updateJobUnchecked(actor: Actor, tx: Tx, id: string, patch: Partial<JobInput>, scope: "one" | "series"): Promise<Job[]> {
  const first = await getRow(tx, id);
  let targets = [first];
  if (scope === "series" && first.seriesId) {
    if (patch.startAt !== undefined || patch.endAt !== undefined || patch.flex !== undefined) {
      throw new ValidationError("Change times one detail at a time.");
    }
    targets = await tx
      .select()
      .from(jobs)
      .where(and(eq(jobs.seriesId, first.seriesId), gte(jobs.startAt, first.startAt), notInArray(jobs.state, ["canceled", "declined"])))
      .orderBy(asc(jobs.startAt), asc(jobs.id));
  }
  const settings = await getSettings(tx);
  const positions = patch.positions ? await normalizePositions(tx, patch.positions, settings) : null;
  const out: Job[] = [];
  // Sequential: each detail of the series is saved in order in this transaction.
  for (const t of targets) out.push(await updateOne(actor, tx, t, patch, settings, positions, scope));
  return out;
}

export type CancelOptions = {
  /**
   * `vendor_hold` cancels a locked detail: sign-ups become late cancellations when the hold was placed inside
   * the late window (or `applyLateCancelPay` is set). `vendor` is a cancel by the vendor or a coordinator for it.
   */
  cause?: "vendor_hold" | "vendor";
  applyLateCancelPay?: boolean;
  now?: Date;
};

export async function cancelJob(actor: Actor, tx: Tx, id: string, reason: string, opts: CancelOptions = {}): Promise<Job> {
  assertCan(actor, "job.cancel", { vendorId: await jobVendorId(tx, id) });
  return cancelJobUnchecked(actor, tx, id, reason, opts);
}

/**
 * cancelJob without the policy check. A late cancellation (cause `vendor` inside `lateVendorCancelHours`
 * of the start, or cause `vendor_hold` per spec 12.7a) turns every signed_up assignment into late_canceled,
 * which bills at once. Any other cancel moves signed_up, pending_short and backup rows to canceled (reason recorded);
 * everyone is alerted of the cancellation.
 */
export async function cancelJobUnchecked(actor: Actor, tx: Tx, id: string, reason: string, opts: CancelOptions = {}): Promise<Job> {
  const why = reason?.trim();
  if (!why) throw new ValidationError("A cancellation reason is required.");
  const cause = opts.cause;
  const now = opts.now ?? new Date();
  const before = await getRow(tx, id);
  if (before.state === "canceled" || before.state === "declined") throw new ValidationError("This job is already closed.");
  const settings = await getSettings(tx);
  const lateMs = settings.lateVendorCancelHours * 3_600_000;
  let late = false;
  if (cause === "vendor") {
    late = before.startAt.getTime() - now.getTime() <= lateMs;
  } else if (cause === "vendor_hold") {
    if (!(await isJobLocked(tx, id))) throw new ValidationError("This detail is not locked by a payment hold.");
    const hold = await openHold(tx, before.vendorId);
    late = !!opts.applyLateCancelPay || (!!hold && before.startAt.getTime() - hold.placedAt.getTime() <= lateMs);
  }
  const audience = await jobAudience(tx, before);
  const [after] = await tx
    .update(jobs)
    .set({ state: "canceled", canceledAt: now, cancelReason: why, canceledByVendor: cause === "vendor" })
    .where(eq(jobs.id, id))
    .returning();
  await recordAudit(tx, { actor, action: "job.cancel", entityType: "job", entityId: id, before, after, reason: why });
  const pending = await tx
    .update(assignments)
    .set({ status: "canceled", removalReason: "Detail canceled" })
    .where(and(eq(assignments.jobId, id), eq(assignments.status, "pending_short")))
    .returning();
  // Sequential: writes and alerts in this transaction.
  for (const a of pending) {
    await recordAudit(tx, { actor, action: "assignment.short_declined", entityType: "assignment", entityId: a.id, before: { ...a, status: "pending_short" }, after: a, reason: "Detail canceled" });
    await emit(tx, { recipients: [a.userId], type: "signup.short_declined", title: `Shorter shift declined: #${after.number} ${after.title}`, body: "Detail canceled", link: `/jobs/${id}` });
  }
  const lateRows = late
    ? await tx
        .update(assignments)
        .set({ status: "late_canceled" })
        .where(and(eq(assignments.jobId, id), eq(assignments.status, "signed_up")))
        .returning()
    : [];
  // Sequential: writes and alerts in this transaction.
  for (const a of lateRows) {
    await recordAudit(tx, { actor, action: "assignment.late_cancel", entityType: "assignment", entityId: a.id, before: { ...a, status: "signed_up" }, after: a, reason: why });
  }
  // Everyone else holding a spot or a place in line is released: no pay without a late cancellation.
  const released = await tx
    .update(assignments)
    .set({ status: "canceled", removalReason: why })
    .where(and(eq(assignments.jobId, id), inArray(assignments.status, ["signed_up", "backup"])))
    .returning();
  // Sequential: writes and alerts in this transaction.
  for (const a of released) {
    await recordAudit(tx, { actor, action: "assignment.job_canceled", entityType: "assignment", entityId: a.id, before: { ...a, status: a.backupPosition === null ? "signed_up" : "backup" }, after: a, reason: why });
  }
  const paid = new Set(lateRows.map((a) => a.userId));
  await emit(tx, { recipients: audience.filter((u) => !paid.has(u)), type: "job.canceled", title: `Detail canceled: #${after.number} ${after.title}`, body: why, link: `/jobs/${id}` });
  await emit(tx, {
    recipients: [...paid],
    type: "job.canceled",
    title: `Detail canceled: #${after.number} ${after.title}`,
    body: `${why}. This is a late cancellation: you are paid for it. Bill it from your unbilled details after its scheduled end.`,
    link: `/jobs/${id}`,
  });
  // Staff canceling tell the vendor's logins; a vendor canceling its own detail already knows. No reason is given.
  if (actor.role === "coordinator" || actor.role === "admin" || managesVendor(actor, after.vendorId)) {
    await emit(tx, { recipients: await vendorAudience(tx, after.vendorId), type: "job.canceled", title: "Detail canceled", body: `Detail #${after.number} on ${dayText(after.startAt)} was canceled.`, link: `/jobs/${id}` });
  }
  return after;
}

// Reactivation

/** The assignment endings a job cancel writes for the people on the detail at that moment. */
const CANCEL_ENDINGS = ["assignment.job_canceled", "assignment.late_cancel", "assignment.short_declined"];

const dayText = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, dateStyle: "medium" }).format(d);

function reactivateViolation(message: string): RuleViolation {
  return new RuleViolation([{ check: "job.reactivate", ok: false, message }], message);
}

/** A vendor asking about another vendor's detail gets NotFound; then only coordinators and admins pass. */
async function reactivationTarget(actor: Actor, tx: Tx, jobId: string, lock = false): Promise<Job> {
  const q = tx.select().from(jobs).where(eq(jobs.id, jobId));
  const [job] = lock ? await q.for("update") : await q;
  if (!job || (actor.role === "vendor" && actor.vendorId !== job.vendorId)) throw new NotFoundError("Job not found.");
  assertCan(actor, "job.reactivate", { vendorId: job.vendorId });
  return job;
}

/** The latest job.cancel audit row: when the detail was canceled and its state just before. */
async function lastCancel(tx: Tx, jobId: string): Promise<{ at: Date; priorState: JobState | null } | null> {
  const [row] = await tx
    .select({ at: auditLog.at, before: auditLog.before })
    .from(auditLog)
    .where(and(eq(auditLog.entityType, "job"), eq(auditLog.entityId, jobId), eq(auditLog.action, "job.cancel")))
    .orderBy(desc(auditLog.at), desc(auditLog.id))
    .limit(1);
  if (!row) return null;
  const prior = (row.before as { state?: JobState } | null)?.state ?? null;
  return { at: row.at, priorState: prior };
}

type ReactivationPerson = { userId: string; name: string };
export type ReactivationPreview = {
  /** Everyone on the detail when it was canceled (signed up, backup or waiting on a shorter shift). */
  notify: ReactivationPerson[];
  /** Late-cancel pay the reactivation cancels (nothing is billable before the end, so none is billed yet). */
  unbilled: Array<ReactivationPerson & { assignmentId: string }>;
};

/** The audit reason (and removal reason) for late-cancel pay a reactivation cancels: the late cancel did not happen. */
const REACTIVATED_REASON = "detail reactivated";

async function peopleAtCancel(tx: Tx, jobId: string, since: Date | null): Promise<ReactivationPerson[]> {
  if (!since) return [];
  const rows = await tx
    .selectDistinct({ userId: assignments.userId, name: users.name })
    .from(auditLog)
    .innerJoin(assignments, eq(assignments.id, auditLog.entityId))
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(eq(auditLog.entityType, "assignment"), inArray(auditLog.action, CANCEL_ENDINGS), eq(assignments.jobId, jobId), gte(auditLog.at, since)))
    .orderBy(asc(users.name), asc(assignments.userId));
  return rows;
}

async function unbilledLateCancels(tx: Tx, jobId: string): Promise<ReactivationPreview["unbilled"]> {
  return tx
    .select({ assignmentId: assignments.id, userId: assignments.userId, name: users.name })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(eq(assignments.jobId, jobId), eq(assignments.status, "late_canceled")))
    .orderBy(asc(users.name), asc(assignments.id));
}

/** Who a reactivation would tell, and whose late-cancel pay it cancels. Coordinators and admins. */
export async function reactivationPreview(actor: Actor, tx: Tx, jobId: string): Promise<ReactivationPreview> {
  const job = await reactivationTarget(actor, tx, jobId);
  return { notify: await peopleAtCancel(tx, job.id, (await lastCancel(tx, job.id))?.at ?? null), unbilled: await unbilledLateCancels(tx, jobId) };
}

/**
 * Brings a canceled detail back, before it ends. It returns to the state it had before the cancel under the normal
 * release rules; the cancel fields stay and the cancel stays in the audit log. No sign-up is restored. The vendor is
 * going ahead, so no late cancel happened: every late-cancel row becomes a plain canceled row (audited), and those
 * people can sign up again like anyone else. Late-cancel pay cannot be billed before the end, so an existing
 * late-cancel invoice (from data before that rule) stops the reactivation. The people who were on it and the vendor
 * are told it is back on; the reason is for coordinators and admins only.
 */
export async function reactivateJob(actor: Actor, tx: Tx, jobId: string, reason: string, now: Date = new Date()): Promise<Job> {
  const before = await reactivationTarget(actor, tx, jobId, true);
  const why = reason?.trim();
  if (!why) throw new ValidationError("A reason is required to reactivate a detail.");
  if (before.state !== "canceled") throw reactivateViolation("Only a canceled detail can be reactivated");
  if (now.getTime() >= before.endAt.getTime()) throw reactivateViolation("This detail has already ended");
  const [billed] = await tx
    .select({ id: invoices.id })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .where(and(eq(assignments.jobId, jobId), eq(invoices.kind, "late_cancel"), notInArray(invoices.status, ["written_off", "returned"])))
    .limit(1);
  if (billed) throw reactivateViolation("Late-cancel pay for this detail was already billed, so it cannot be reactivated");
  const cancel = await lastCancel(tx, jobId);
  const prior = cancel?.priorState;
  const state: JobState = prior && prior !== "canceled" && prior !== "declined" ? prior : "scheduled";
  // A waiver belongs to the cancel it waived: a later cancel offers the waiver again (the audit keeps the old one).
  const set: Partial<typeof jobs.$inferInsert> = { state, lateCancelWaivedReason: null };
  // A vendor request that was canceled before approval goes back to waiting for a decision, with no release time.
  if (state !== "requested") set.releaseAt = restoredReleaseAt(before, await getSettings(tx), now);
  const [after] = await tx.update(jobs).set(set).where(eq(jobs.id, jobId)).returning();
  await recordAudit(tx, { actor, action: "job.reactivate", entityType: "job", entityId: jobId, before, after, reason: why });

  const voided = await tx
    .update(assignments)
    .set({ status: "canceled", removalReason: REACTIVATED_REASON })
    .where(and(eq(assignments.jobId, jobId), eq(assignments.status, "late_canceled")))
    .returning();
  // Sequential: writes and alerts in this transaction.
  for (const a of voided) {
    await recordAudit(tx, { actor, action: LATE_CANCEL_VOID_ACTION, entityType: "assignment", entityId: a.id, before: { ...a, status: "late_canceled", removalReason: null }, after: a, reason: REACTIVATED_REASON });
  }

  const on = `Detail #${after.number} on ${dayText(after.startAt)}`;
  const people = await peopleAtCancel(tx, jobId, cancel?.at ?? null);
  await emit(tx, { recipients: people.map((p) => p.userId), type: "job.reactivated", title: `Detail back on: #${after.number} ${after.title}`, body: `${on} is back on. Sign up again if you still want it.`, link: `/jobs/${jobId}` });
  await emit(tx, { recipients: await vendorAudience(tx, after.vendorId), type: "job.reactivated", title: `Detail reactivated: #${after.number} ${after.title}`, body: `${on} has been reactivated.`, link: `/jobs/${jobId}` });
  return after;
}

/** This job, or with `series` this and every later open job in its series, locked in start order. */
async function scopeTargets(tx: Tx, id: string, scope: "one" | "series"): Promise<Job[]> {
  const first = await getRow(tx, id);
  if (scope === "one" || !first.seriesId) return [first];
  return tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.seriesId, first.seriesId), gte(jobs.startAt, first.startAt), notInArray(jobs.state, ["canceled", "declined"])))
    .orderBy(asc(jobs.startAt), asc(jobs.id))
    .for("update");
}

/**
 * Holds a detail (or this and the later details of its series): it leaves the open lists and takes no new
 * sign-ups; people already on it keep their spots and are not alerted. Already held or closed details are skipped.
 */
export async function holdJob(actor: Actor, tx: Tx, id: string, scope: "one" | "series"): Promise<Job[]> {
  assertCan(actor, "job.update", { vendorId: await jobVendorId(tx, id) });
  const out: Job[] = [];
  // Sequential: each detail is saved and audited in order in this transaction.
  for (const before of await scopeTargets(tx, id, scope)) {
    if (before.state === "canceled" || before.state === "declined") throw new ValidationError("A canceled or declined detail cannot be held.");
    if (before.held) {
      out.push(before);
      continue;
    }
    const [after] = await tx.update(jobs).set({ held: true }).where(eq(jobs.id, before.id)).returning();
    await recordAudit(tx, { actor, action: "job.hold", entityType: "job", entityId: before.id, before: { held: false }, after: { held: true } });
    out.push(after);
  }
  return out;
}

/**
 * Clears a hold (or the series' holds from this detail on). With `now`, a detail whose release time has not come
 * opens at once: releaseAt becomes now, so watchers are alerted by the release tick as for any release.
 */
export async function releaseJob(actor: Actor, tx: Tx, id: string, opts: { scope: "one" | "series"; now: boolean }, at: Date = new Date()): Promise<Job[]> {
  assertCan(actor, "job.update", { vendorId: await jobVendorId(tx, id) });
  const out: Job[] = [];
  // Sequential: each detail is saved and audited in order in this transaction.
  for (const before of await scopeTargets(tx, id, opts.scope)) {
    if (before.state === "canceled" || before.state === "declined") throw new ValidationError("A canceled or declined detail cannot be released.");
    const set: Partial<typeof jobs.$inferInsert> = {};
    if (before.held) set.held = false;
    const early = opts.now && before.state !== "requested" && (!before.releaseAt || before.releaseAt.getTime() > at.getTime());
    if (early) set.releaseAt = at;
    if (!Object.keys(set).length) {
      out.push(before);
      continue;
    }
    const [after] = await tx.update(jobs).set(set).where(eq(jobs.id, before.id)).returning();
    if (before.held) await recordAudit(tx, { actor, action: "job.release_hold", entityType: "job", entityId: before.id, before: { held: true }, after: { held: false } });
    if (early) await recordAudit(tx, { actor, action: "job.release_now", entityType: "job", entityId: before.id, before: { releaseAt: before.releaseAt }, after: { releaseAt: at } });
    out.push(after);
  }
  return out;
}

/** Clears one detail's hold; kept for existing callers. */
export async function releaseHold(actor: Actor, tx: Tx, id: string): Promise<Job> {
  return (await releaseJob(actor, tx, id, { scope: "one", now: false }))[0];
}

export type JobDetail = Job & {
  positions: JobPosition[];
  personnelTotal: number;
  safety: JobSafetyView | null;
  attachments: JobAttachment[];
  /** Coordinators and admins only. */
  contractStatus: ContractStatus | null;
};

/**
 * A vendor actor gets NotFound for anyone else's job. Contract attachments are
 * visible to coordinators, admins and that vendor only. Deputy notes and flags
 * (later tasks) must stay out of the vendor view.
 */
export async function getJob(actor: Actor, tx: Tx, id: string): Promise<JobDetail> {
  const job = await getRow(tx, id);
  if (actor.role === "vendor" && actor.vendorId !== job.vendorId) throw new NotFoundError("Job not found.");
  // Personnel never see a vendor request before it is approved, or one that was declined, unless they manage the vendor.
  if (actor.role === "personnel" && HIDDEN_FROM_PERSONNEL.includes(job.state) && !managesVendor(actor, job.vendorId)) throw new NotFoundError("Job not found.");
  assertCan(actor, "job.read", { vendorId: job.vendorId });
  const positions = await tx.select().from(jobPositions).where(eq(jobPositions.jobId, id)).orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const attachments = await tx.select().from(jobAttachments).where(eq(jobAttachments.jobId, id)).orderBy(asc(jobAttachments.createdAt), asc(jobAttachments.id));
  const staff = actor.role === "admin" || actor.role === "coordinator" || managesVendor(actor, job.vendorId);
  const seesContracts = staff || actor.role === "vendor";
  return {
    ...jobFieldsFor(actor, job),
    positions,
    personnelTotal: positions.reduce((n, p) => n + p.count, 0),
    safety: await loadSafety(tx, id),
    attachments: seesContracts ? attachments : attachments.filter((a) => !a.isContract),
    contractStatus: staff ? await jobContractStatus(tx, id) : null,
  };
}

/**
 * A job row as `actor` may see it. Staff see every field. Personnel and vendors never see an approved
 * out-of-range rate's reason, approver and time (owner decision: audit log and the staff page only) or the
 * late-cancel waiver's reason, and see why and by whom a detail was canceled only while it is canceled (a
 * declined request keeps its reason for the vendor). Billing reads the row itself, never this view. Every path
 * that hands job rows to non-staff goes through here.
 */
export function jobFieldsFor<T extends Job>(actor: Actor, job: T): T {
  if (actor.role === "admin" || actor.role === "coordinator" || managesVendor(actor, job.vendorId)) return job;
  const staffOnly = { rateOverrideReason: null, rateOverrideBy: null, rateOverrideAt: null, lateCancelWaivedReason: null };
  if (job.state === "canceled" || job.state === "declined") return { ...job, ...staffOnly };
  return { ...job, ...staffOnly, cancelReason: null, canceledAt: null, canceledByVendor: false };
}

/** Job states personnel never see: unapproved vendor requests and declined ones. */
export const HIDDEN_FROM_PERSONNEL: JobState[] = ["requested", "declined"];

export type JobSort = "date" | "vendor" | "location" | "rate" | "total_pay";

export type JobFilter = {
  from: Date;
  to: Date;
  /** Also lists details that started before `from` and are still running at this instant (a "today" or upcoming list). */
  runningAt?: Date;
  status?: JobState[];
  typeIds?: string[];
  vendorIds?: string[];
  text?: string;
  mine?: boolean;
  /** Hides details that overlap the person's own work schedule (with buffer) or imported calendar. Never blocks a sign-up. */
  onlyWorkable?: boolean;
  /** Default `date`. Ties fall back to the start time, then the job number. */
  sort?: JobSort;
  /** Default `asc`. */
  direction?: "asc" | "desc";
};

/** Billable minutes at the job rate, in cents: the same arithmetic as `scheduledPayCents`, for ordering in SQL. */
function totalPayExpr(settings: AgencySettings): SQL {
  const minutes = sql`(extract(epoch from (${jobs.endAt} - ${jobs.startAt})) / 60)`;
  const rounded = sql`(ceil(${minutes} / ${settings.hourRoundingMinutes}::numeric) * ${settings.hourRoundingMinutes})`;
  const minimum = sql`coalesce(${jobs.minimumBillableMinutes}, ${vendors.minimumBillableMinutes}, ${settings.minimumBillableMinutes})`;
  return sql`round(greatest(${rounded}, ${minimum})::numeric * ${jobs.rateCents} / 60)`;
}

function orderFor(sort: JobSort, direction: "asc" | "desc", settings: AgencySettings): SQL[] {
  const dir = direction === "desc" ? desc : asc;
  const tail = [asc(jobs.startAt), desc(jobs.number)];
  switch (sort) {
    case "vendor":
      return [dir(vendors.name), ...tail];
    case "location":
      // Details without a location always sort last.
      return [sql`${vendorLocations.name} is null`, dir(vendorLocations.name), ...tail];
    case "rate":
      return [dir(jobs.rateCents), ...tail];
    case "total_pay":
      return [dir(totalPayExpr(settings)), ...tail];
    default:
      return direction === "desc" ? [desc(jobs.startAt), desc(jobs.number)] : tail;
  }
}

function assertCanList(actor: Actor): void {
  if (actor.role === "vendor") {
    if (!actor.vendorId) throw new NotFoundError("Job not found.");
    assertCan(actor, "job.read", { vendorId: actor.vendorId });
  } else {
    assertCan(actor, "job.read");
  }
}

/** A search on the title, description, vendor, location, or the job number ("1234" or "#1234"). */
function textMatch(q: string): SQL | undefined {
  const like = `%${q.replace(/[\\%_]/g, "\\$&")}%`;
  const number = /^#?(\d{1,9})$/.exec(q);
  return or(
    ilike(jobs.title, like),
    ilike(jobs.description, like),
    ilike(vendors.name, like),
    ilike(vendorLocations.name, like),
    ...(number ? [eq(jobs.number, Number(number[1]))] : []),
  );
}

/**
 * Details of a vendor on payment hold leave a person's open lists; so do hidden and restricted vendors (discovery
 * only), and held details. People already on a detail keep seeing it.
 */
function openListVisibility(tx: Tx, userId: string): SQL | undefined {
  const heldVendors = tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.paymentHold, true));
  const hiddenByMe = tx.select({ id: hiddenVendors.vendorId }).from(hiddenVendors).where(eq(hiddenVendors.userId, userId));
  const restrictedFromMe = tx
    .select({ id: vendorRestrictions.vendorId })
    .from(vendorRestrictions)
    .where(and(eq(vendorRestrictions.userId, userId), isNull(vendorRestrictions.liftedAt)));
  const mineRows = tx
    .select({ jobId: assignments.jobId })
    .from(assignments)
    .where(and(eq(assignments.userId, userId), notInArray(assignments.status, ["canceled", "removed"])));
  return or(and(eq(jobs.held, false), notInArray(jobs.vendorId, heldVendors), notInArray(jobs.vendorId, hiddenByMe), notInArray(jobs.vendorId, restrictedFromMe)), inArray(jobs.id, mineRows));
}

/**
 * Details starting in [from, to], plus, with `runningAt`, those that started earlier and end after it, so an
 * overnight detail stays on today's list until it ends.
 */
export function startWindow(range: { from: Date; to: Date; runningAt?: Date }): SQL {
  const starts = and(gte(jobs.startAt, range.from), lte(jobs.startAt, range.to))!;
  return range.runningAt ? or(starts, and(lt(jobs.startAt, range.from), gt(jobs.endAt, range.runningAt)))! : starts;
}

/** The list conditions from the filter and the actor's role, apart from `mine`, which needs a query. */
function filterConds(actor: Actor, tx: Tx, filter: JobFilter): SQL[] {
  const conds: SQL[] = [startWindow(filter)];
  if (actor.role === "vendor" && actor.vendorId) conds.push(eq(jobs.vendorId, actor.vendorId));
  if (filter.status?.length) conds.push(inArray(jobs.state, filter.status));
  const managed = actor.role === "personnel" ? [...(actor.managedVendorIds ?? [])] : [];
  // A vendor manager also sees their vendors' held details in the lists (owner decision 2026-11-27); requests stay on Manage.
  const theirVendors = managed.length ? inArray(jobs.vendorId, managed) : undefined;
  if (actor.role === "personnel") conds.push(notInArray(jobs.state, HIDDEN_FROM_PERSONNEL));
  if (filter.typeIds?.length) conds.push(inArray(jobs.typeId, filter.typeIds));
  if (filter.vendorIds?.length) conds.push(inArray(jobs.vendorId, filter.vendorIds));
  const q = filter.text?.trim();
  const match = q ? textMatch(q) : undefined;
  if (match) conds.push(match);
  const visible = actor.role === "personnel" && !filter.mine ? openListVisibility(tx, actor.userId) : undefined;
  if (visible) conds.push(theirVendors ? or(visible, theirVendors)! : visible);
  return conds;
}

/**
 * Jobs starting in [from, to], 50 per page (page is 1-based), soonest first unless `sort` says otherwise. Vendors see
 * only their own. Personnel lists leave out vendors on payment hold, vendors the person hid and vendors they are
 * restricted from, except for details the person is already on.
 */
export async function listJobs(actor: Actor, tx: Tx, filter: JobFilter, page: number): Promise<Job[]> {
  assertCanList(actor);
  const conds = filterConds(actor, tx, filter);
  if (filter.mine) {
    const mine = await tx
      .select({ jobId: assignments.jobId })
      .from(assignments)
      .where(and(eq(assignments.userId, actor.userId), notInArray(assignments.status, ["canceled", "removed"])));
    const ids = mine.map((m) => m.jobId);
    if (ids.length === 0) return [];
    conds.push(inArray(jobs.id, ids));
  }
  const p = Math.max(1, Math.floor(page));
  if (filter.onlyWorkable && filter.to.getTime() - filter.from.getTime() > MAX_WORKABLE_RANGE_DAYS * 86_400_000) {
    throw new ValidationError(`Choose a date range of ${MAX_WORKABLE_RANGE_DAYS} days or less to show only the details you can work.`);
  }
  const settings = await getSettings(tx);
  const query = tx
    .select(getTableColumns(jobs))
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
    .where(and(...conds))
    .orderBy(...orderFor(filter.sort ?? "date", filter.direction ?? "asc", settings));
  if (!filter.onlyWorkable) return (await query.limit(JOBS_PAGE_SIZE).offset((p - 1) * JOBS_PAGE_SIZE)).map((j) => jobFieldsFor(actor, j));

  // The schedule is a private filter: apply it to the whole (bounded) result, then page.
  const workable = await workableOnly(tx, actor.userId, await query);
  return workable.slice((p - 1) * JOBS_PAGE_SIZE, p * JOBS_PAGE_SIZE).map((j) => jobFieldsFor(actor, j));
}

/** The jobs that fit the person's work schedule. */
async function workableOnly(tx: Tx, userId: string, all: Job[]): Promise<Job[]> {
  if (all.length === 0) return [];
  let lo = Infinity;
  let hi = -Infinity;
  for (const j of all) {
    lo = Math.min(lo, j.flexEarliestStartAt?.getTime() ?? j.startAt.getTime());
    hi = Math.max(hi, j.flexLatestEndAt?.getTime() ?? j.endAt.getTime());
  }
  const duty = await loadDuty(tx, userId, new Date(lo), new Date(hi));
  return all.filter((j) =>
    fitsSchedule(
      { startAt: j.startAt, endAt: j.endAt, flex: j.flexEarliestStartAt && j.flexLatestEndAt ? { earliestStartAt: j.flexEarliestStartAt, latestEndAt: j.flexLatestEndAt, allowShorter: j.flexAllowShorter } : null },
      duty,
    ),
  );
}
