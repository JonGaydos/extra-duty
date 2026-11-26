import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobAttachments, jobPositions, jobSeries, jobs } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";
import { getSettings } from "../settings/settings";
import { agencyDayKey } from "../time/agency-time";
import { createJobInSeries, type CreateOptions, type Job, type JobInput } from "./jobs";
import { expandDates, MAX_BULK_DATES, previewBulk, type DateSelection, type Recurrence, type TimeOverrides } from "./recurrence";
import { loadSafety, resolveSafetyPins } from "./safety";
import { byText } from "@/lib/sort";

export type BulkOptions = {
  /** Copy this job's attachments (contract included) onto every new job. */
  attachmentsFromJobId?: string;
  /** Add to an existing series instead of starting a new one. */
  seriesId?: string;
  /** Vendor requests: create as `requested` for an actor the caller has already authorized. */
  create?: CreateOptions;
};

async function copyAttachments(tx: Tx, fromJobId: string, toJobId: string): Promise<void> {
  const rows = await tx.select().from(jobAttachments).where(eq(jobAttachments.jobId, fromJobId)).orderBy(asc(jobAttachments.createdAt), asc(jobAttachments.id));
  if (rows.length === 0) return;
  // Same file row, new attachment row.
  await tx.insert(jobAttachments).values(rows.map((a) => ({ jobId: toJobId, label: a.label, fileId: a.fileId, url: a.url, isContract: a.isContract })));
}

/** createJobInSeries, with a validation message that names the failing date. */
async function createOne(actor: Actor, tx: Tx, date: string, input: JobInput, seriesId: string, create?: CreateOptions): Promise<Job> {
  try {
    return await createJobInSeries(actor, tx, input, seriesId, create);
  } catch (e) {
    if (e instanceof ValidationError) throw new ValidationError(`${date}: ${e.message}`);
    throw e;
  }
}

/**
 * One detail on many dates in a single save. Everything runs in the caller's
 * transaction, so any failing date undoes the whole batch. Every job shares a
 * new series; positions, flex and safety come from `input`, wall-clock times
 * from its start and end (see previewBulk).
 */
export async function createJobsOnDates(actor: Actor, tx: Tx, input: JobInput, dates: string[], overrides?: TimeOverrides, opts: BulkOptions = {}): Promise<Job[]> {
  if (!opts.create?.authorized) assertCan(actor, "job.create");
  const unique = [...new Set(dates)].sort(byText);
  if (unique.length === 0) throw new ValidationError("Choose at least one date.");
  if (unique.length > MAX_BULK_DATES) throw new ValidationError(`At most ${MAX_BULK_DATES} dates can be created at once.`);
  const settings = await getSettings(tx);
  const plan = previewBulk(input, unique, overrides, settings);
  // Look addresses up once here (a no-op when already resolved) instead of once per date.
  const safety = input.safety ? await resolveSafetyPins(input.safety) : undefined;

  let seriesId = opts.seriesId;
  let created = false;
  if (!seriesId) {
    [{ id: seriesId }] = await tx.insert(jobSeries).values({ name: input.title?.trim() || null }).returning({ id: jobSeries.id });
    created = true;
  }
  const startMs = input.startAt.getTime();
  const endMs = input.endAt.getTime();
  const out: Job[] = [];
  // Sequential: jobs are created one by one, in date order, in this transaction.
  for (const p of plan) {
    const shift = (d: Date | null | undefined, from: number, to: Date) => (d ? new Date(to.getTime() + (d.getTime() - from)) : d);
    const job = await createOne(
      actor,
      tx,
      p.date,
      {
        ...input,
        // An approved out-of-range rate belongs to one detail; bulk dates never carry it.
        rateOverrideReason: null,
        startAt: p.startAt,
        endAt: p.endAt,
        safety,
        flex: input.flex
          ? { ...input.flex, earliestStartAt: shift(input.flex.earliestStartAt, startMs, p.startAt)!, latestEndAt: shift(input.flex.latestEndAt, endMs, p.endAt)! }
          : input.flex,
        opsPlanDueAt: shift(input.opsPlanDueAt, startMs, p.startAt) ?? null,
      },
      seriesId,
      opts.create,
    );
    if (opts.attachmentsFromJobId) await copyAttachments(tx, opts.attachmentsFromJobId, job.id);
    out.push(job);
  }
  if (created) {
    await recordAudit(tx, { actor, action: "series.created", entityType: "job_series", entityId: seriesId, before: null, after: { dates: unique, jobIds: out.map((j) => j.id) } });
  }
  return out;
}

async function loadSource(tx: Tx, id: string): Promise<{ job: Job; input: JobInput }> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, id));
  if (!job) throw new NotFoundError("Job not found.");
  const positions = await tx.select().from(jobPositions).where(eq(jobPositions.jobId, id)).orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const safety = await loadSafety(tx, id);
  return {
    job,
    input: {
      vendorId: job.vendorId,
      locationId: job.locationId,
      typeId: job.typeId,
      title: job.title,
      description: job.description,
      notes: job.notes,
      startAt: job.startAt,
      endAt: job.endAt,
      rateCents: job.rateCents,
      positions: positions.map((p) => ({
        positionTypeId: p.positionTypeId,
        count: p.count,
        ...(p.eligibleRankIdsOverride ? { eligibleRankIdsOverride: p.eligibleRankIdsOverride } : {}),
        ...(p.requiredQualificationIdsOverride ? { requiredQualificationIdsOverride: p.requiredQualificationIdsOverride } : {}),
      })),
      opsPlanRequired: job.opsPlanRequired,
      opsPlanDueAt: job.opsPlanDueAt,
      contactName: job.contactName,
      contactPhone: job.contactPhone,
      held: job.held,
      flex:
        job.flexEarliestStartAt && job.flexLatestEndAt
          ? { earliestStartAt: job.flexEarliestStartAt, latestEndAt: job.flexLatestEndAt, allowShorter: job.flexAllowShorter }
          : null,
      // Pins are already stored, so nothing is looked up again.
      safety: safety
        ? { notes: safety.notes ?? "", addresses: safety.addresses.map((a) => ({ address: a.address, description: a.description ?? "", lat: a.lat, lng: a.lng, source: a.source })) }
        : undefined,
    },
  };
}

export type CopyResult = { jobs: Job[] };

export type CopyOptions = {
  /** Test hook; defaults to the current time. */
  now?: Date;
};

/**
 * Copies a job onto the selected dates (one new series, one transaction). Past agency dates are refused. A copy
 * carries the detail itself and never its people (owner decision, Task 44a): vendor, location, title, description,
 * notes, positions with the source's rate differentials, rate, flexible times, officer safety with its pins, site
 * contact and attachments, contract included (the copies point at the same stored files). Each copy starts with an
 * empty roster under the normal release rules.
 */
export async function copyJob(actor: Actor, tx: Tx, sourceId: string, selection: DateSelection, opts: CopyOptions = {}): Promise<CopyResult> {
  assertCan(actor, "job.create");
  const now = opts.now ?? new Date();
  const { job, input } = await loadSource(tx, sourceId);
  const firstDate = agencyDayKey(job.startAt);
  let dates = expandDates(selection, firstDate);
  // A pattern starts on the source's own date, which already has the job.
  if (selection.kind === "pattern") dates = dates.filter((d) => d !== firstDate);
  refusePastDates(dates, now);
  const created = await createJobsOnDates(actor, tx, input, dates, undefined, { attachmentsFromJobId: sourceId });
  await keepDifferentials(tx, sourceId, created);
  return { jobs: created };
}

/** A copy (single, to many dates, or a Repeat) is never made on a date before today's agency date. */
function refusePastDates(dates: string[], now: Date): void {
  const today = agencyDayKey(now);
  const past = [...dates].sort(byText).find((d) => d < today);
  if (past) throw new ValidationError(`${past}: A copy cannot be made on a past date. Choose today or a later date.`);
}

/**
 * Positions snapshot their type's rate differential when they are added; a copy keeps the source's snapshot, not
 * whatever the type says today. Positions are created in the source's order.
 */
async function keepDifferentials(tx: Tx, sourceId: string, copies: Job[]): Promise<void> {
  const ordered = (jobId: string) => tx.select().from(jobPositions).where(eq(jobPositions.jobId, jobId)).orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const source = await ordered(sourceId);
  // Sequential: writes in this transaction.
  for (const c of copies) {
    const mine = await ordered(c.id);
    // Sequential: writes in this transaction.
    for (const [i, p] of mine.entries()) {
      const want = source[i];
      if (want?.positionTypeId === p.positionTypeId && want.rateDifferentialCents !== p.rateDifferentialCents) {
        await tx.update(jobPositions).set({ rateDifferentialCents: want.rateDifferentialCents }).where(eq(jobPositions.id, p.id));
      }
    }
  }
}

/**
 * Repeats an existing job on a pattern. The job itself is the first occurrence:
 * it joins the series (when it has none) and only the later dates are created. Like any copy, it carries the detail
 * and its attachments with the source's rate differentials, never the people, and refuses past dates.
 */
export async function createRecurringJobs(actor: Actor, tx: Tx, sourceId: string, r: Recurrence, now: Date = new Date()): Promise<Job[]> {
  assertCan(actor, "job.create");
  const { job, input } = await loadSource(tx, sourceId);
  const firstDate = agencyDayKey(job.startAt);
  const dates = expandDates({ kind: "pattern", recurrence: r }, firstDate).filter((d) => d !== firstDate);
  if (dates.length === 0) throw new ValidationError("That pattern has no dates after this job.");
  refusePastDates(dates, now);
  let seriesId = job.seriesId;
  const newSeries = !seriesId;
  if (!seriesId) {
    [{ id: seriesId }] = await tx.insert(jobSeries).values({ name: job.title }).returning({ id: jobSeries.id });
    await tx.update(jobs).set({ seriesId }).where(eq(jobs.id, job.id));
    await recordAudit(tx, { actor, action: "job.series_attached", entityType: "job", entityId: job.id, before: { seriesId: null }, after: { seriesId } });
  }
  const out = await createJobsOnDates(actor, tx, input, dates, undefined, { seriesId, attachmentsFromJobId: sourceId });
  await keepDifferentials(tx, sourceId, out);
  if (newSeries) {
    await recordAudit(tx, { actor, action: "series.created", entityType: "job_series", entityId: seriesId, before: null, after: { dates: [firstDate, ...dates], jobIds: [job.id, ...out.map((j) => j.id)] } });
  }
  return out;
}
