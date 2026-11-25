import { and, asc, desc, eq, ilike, lt, ne, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { files, jobs, opsPlanVersions, opsPlans, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assertCan } from "@/domain/auth/policy";
import { ValidationError } from "@/domain/errors";
import { agencyDateParts } from "@/domain/time/agency-time";

export const LIBRARY_PAGE_SIZE = 25;
export const LIBRARY_TEXT_MAX = 200;
/** Minimum `pg_trgm` similarity between a new job's title and a prior plan's event name. */
export const PRIOR_PLAN_SIMILARITY = 0.6;

export type OpsPlanSummary = {
  opsPlanId: string;
  jobId: string;
  jobTitle: string;
  startAt: Date;
  year: number;
  location: string | null;
  vendorId: string;
  vendorName: string;
  icName: string | null;
  versionId: string;
  fileId: string;
  filename: string;
};
/** One library row; the same shape as a suggestion. */
export type OpsPlanLibraryRow = OpsPlanSummary;

export type LibraryFilter = { text?: string; vendorId?: string; year?: number; location?: string };

const escapeLike = (s: string) => `%${s.replace(/[\\%_]/g, "\\$&")}%`;

const summaryColumns = {
  opsPlanId: opsPlans.id,
  jobId: jobs.id,
  jobTitle: jobs.title,
  startAt: jobs.startAt,
  year: opsPlans.year,
  location: opsPlans.location,
  vendorId: vendors.id,
  vendorName: vendors.name,
  icName: users.name,
  versionId: opsPlanVersions.id,
  fileId: files.id,
  filename: files.filename,
};

/** Agreed plans of past jobs, each shown once with its latest agreed version. */
function agreedPlans(tx: Tx, now: Date) {
  const newerAgreed = sql`not exists (
    select 1 from ops_plan_versions nv
    where nv.ops_plan_id = ${opsPlanVersions.opsPlanId} and nv.decision = 'agreed'
      and (nv.submitted_at, nv.id) > (${opsPlanVersions.submittedAt}, ${opsPlanVersions.id}))`;
  return {
    conds: [eq(opsPlanVersions.decision, "agreed"), lt(jobs.endAt, now), ne(jobs.state, "canceled"), newerAgreed],
    query: tx
      .select(summaryColumns)
      .from(opsPlanVersions)
      .innerJoin(opsPlans, eq(opsPlans.id, opsPlanVersions.opsPlanId))
      .innerJoin(jobs, eq(jobs.id, opsPlans.jobId))
      .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
      .innerJoin(files, eq(files.id, opsPlanVersions.fileId))
      .leftJoin(users, eq(users.id, opsPlanVersions.submittedBy)),
  };
}

/**
 * Agreed plans of past jobs (a plan with at least one agreed version), newest job first, each with its latest
 * agreed version's file, 25 per page (`page` is 1-based). `text` matches the job title, event, location and
 * vendor name; `year` is the plan's year; `location` matches the plan's location name.
 * Personnel, coordinators and admins; vendors refused.
 */
export async function searchLibrary(actor: Actor, tx: Tx, filter: LibraryFilter, page: number = 1, now: Date = new Date()): Promise<OpsPlanSummary[]> {
  assertCan(actor, "job.read");
  if (!Number.isSafeInteger(page) || page < 1) throw new ValidationError("The page must be a positive whole number.");
  const location = filter.location?.trim();
  const text = filter.text?.trim();
  if ((location?.length ?? 0) > LIBRARY_TEXT_MAX || (text?.length ?? 0) > LIBRARY_TEXT_MAX) throw new ValidationError(`Search text can be at most ${LIBRARY_TEXT_MAX} characters.`);
  const { conds, query } = agreedPlans(tx, now);
  if (filter.vendorId) conds.push(eq(vendors.id, filter.vendorId));
  if (filter.year !== undefined) conds.push(eq(opsPlans.year, filter.year));
  if (location) conds.push(ilike(opsPlans.location, escapeLike(location)));
  if (text) {
    const like = escapeLike(text);
    conds.push(or(ilike(jobs.title, like), ilike(opsPlans.eventName, like), ilike(opsPlans.location, like), ilike(vendors.name, like))!);
  }
  const offset = (page - 1) * LIBRARY_PAGE_SIZE;
  return query
    .where(and(...conds))
    .orderBy(desc(jobs.startAt), asc(opsPlans.id))
    .limit(LIBRARY_PAGE_SIZE)
    .offset(offset);
}

/**
 * Last year's plan as a starting point for a repeat event: the same vendor's agreed plan whose event name is
 * similar to the title (`pg_trgm` similarity >= 0.6), from an earlier agency year than `startAt`. The most
 * recent past year wins, then the closest title. Null when none.
 */
export async function suggestPriorPlan(tx: Tx, input: { vendorId: string; title: string; startAt: Date }, now: Date = new Date()): Promise<OpsPlanSummary | null> {
  const { conds, query } = agreedPlans(tx, now);
  const similarity = sql<number>`similarity(${opsPlans.eventName}, ${input.title})`;
  const [row] = await query
    .where(and(...conds, eq(vendors.id, input.vendorId), lt(opsPlans.year, agencyDateParts(input.startAt).year), sql`${similarity} >= ${PRIOR_PLAN_SIMILARITY}`))
    .orderBy(desc(opsPlans.year), desc(similarity), desc(jobs.startAt), asc(opsPlans.id))
    .limit(1);
  return row ?? null;
}
