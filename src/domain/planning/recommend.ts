import { and, asc, eq, gt, gte, inArray, isNull, lt, lte, notInArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, hiddenVendors, jobPositions, jobs, seasons, vendorRestrictions, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { eligibilityFor } from "../assignments/signup";
import { billableMinutes, invoiceTotal, resolveMinimum } from "../billing/rules";
import { evaluateCaps } from "../caps/caps";
import { APPROVED_STATES } from "../release/release";
import { positionRateCents } from "../jobs/rate";
import { NotFoundError } from "../errors";
import { jobFieldsFor, type Job } from "../jobs/jobs";
import { earningsDashboard } from "../reports/earnings";
import { getSettings, type AgencySettings } from "../settings/settings";
import { agencyDateParts, agencyInstant, minutesBetween } from "../time/agency-time";
import type { Cents } from "../types";
import { getEarningsGoal } from "./preferences";
import { assertOwn, bestPlacement, loadDuty, scheduleShiftsForCaps, type Interval, type PlannedJob } from "./schedule";

const DAY_MS = 86_400_000;
export const RECOMMENDATION_DAYS = 60;
const MAX_CANDIDATES = 200;

/** What the detail pays at its scheduled hours: billable minutes (rounding, then the minimum) at the job rate. */
export function scheduledPayCents(
  job: Pick<Job, "rateCents" | "minimumBillableMinutes">,
  vendorMinimum: number | null,
  settings: Pick<AgencySettings, "minimumBillableMinutes" | "hourRoundingMinutes">,
  span: Interval,
): Cents {
  const minimum = resolveMinimum(job.minimumBillableMinutes, vendorMinimum, settings.minimumBillableMinutes);
  const minutes = billableMinutes(minutesBetween(span.startAt, span.endAt), { minimumBillableMinutes: minimum, hourRoundingMinutes: settings.hourRoundingMinutes });
  return invoiceTotal(minutes, job.rateCents);
}

export type Candidate = { jobPositionId: string; startAt: Date; endAt: Date; totalCents: Cents; flex?: PlannedJob["flex"] };

export type RecommendInput = {
  /** Already filtered to eligible, released, open and not hidden. */
  candidates: Candidate[];
  remainingCents: Cents;
  /** The person's sign-ups. */
  existing: Interval[];
  /** On-duty time with buffers, plus imported calendar busy time. */
  duty: Interval[];
  /** Whether the hour caps still hold; the last interval is the one being added to the earlier picks. */
  capCheck: (picked: Interval[]) => boolean;
};

type Blockers = Pick<RecommendInput, "existing" | "duty" | "capCheck">;

/** Where the candidate would go among the earlier picks (own times or its best flex placement), or null when it does not fit or breaks a cap. */
function place(input: Blockers, picked: Interval[], c: Pick<Candidate, "startAt" | "endAt" | "flex">): Interval | null {
  const placement = bestPlacement({ startAt: c.startAt, endAt: c.endAt, flex: c.flex }, [...input.duty, ...input.existing, ...picked]);
  if (!placement) return null;
  return input.capCheck([...picked, placement]) ? placement : null;
}

/** The chosen details with the placement each would take, soonest first. */
export function pickRecommendations(input: RecommendInput): Array<{ jobPositionId: string; placement: Interval }> {
  const picked: Array<{ jobPositionId: string; placement: Interval }> = [];
  let total = 0;
  if (input.remainingCents <= 0) return picked;
  const ordered = input.candidates.map((c, i) => ({ c, i })).sort((a, b) => a.c.startAt.getTime() - b.c.startAt.getTime() || a.i - b.i);
  for (const { c } of ordered) {
    if (total >= input.remainingCents) break;
    const placement = place(input, picked.map((p) => p.placement), c);
    if (!placement) continue;
    picked.push({ jobPositionId: c.jobPositionId, placement });
    total += c.totalCents;
  }
  return picked;
}

/** Position ids to suggest: soonest first, no overlaps, stopping once the picks reach the remaining goal. */
export function recommendDetails(input: RecommendInput): string[] {
  return pickRecommendations(input).map((p) => p.jobPositionId);
}

function agencyMonth(now: Date): { start: Date; next: Date } {
  const p = agencyDateParts(now);
  return { start: agencyInstant(p.year, p.month, 1, 0, 0), next: agencyInstant(p.year, p.month + 1, 1, 0, 0) };
}

/** This agency month: billed so far, signed up (scheduled pay at billable minutes) and what is left of the goal. */
export async function goalProgress(actor: Actor, tx: Tx, now: Date): Promise<{ goalCents: Cents | null; earnedCents: Cents; signedUpCents: Cents; remainingCents: Cents }> {
  assertOwn(actor);
  const goalCents = await getEarningsGoal(actor, tx, actor.userId);
  const earnedCents = (await earningsDashboard(actor, tx, actor.userId, now)).thisMonth.billedCents;
  const settings = await getSettings(tx);
  const { start, next } = agencyMonth(now);
  const rows = await tx
    .select({ a: assignments, job: jobs, vendorMinimum: vendors.minimumBillableMinutes, differential: jobPositions.rateDifferentialCents })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(and(eq(assignments.userId, actor.userId), eq(assignments.status, "signed_up"), gte(jobs.startAt, start), lt(jobs.startAt, next)));
  let signedUpCents = 0;
  for (const r of rows) {
    signedUpCents += scheduledPayCents({ ...r.job, rateCents: positionRateCents(r.job.rateCents, { rateDifferentialCents: r.differential }) }, r.vendorMinimum, settings, { startAt: r.a.plannedStartAt ?? r.job.startAt, endAt: r.a.plannedEndAt ?? r.job.endAt });
  }
  const remainingCents = goalCents === null ? 0 : Math.max(0, goalCents - earnedCents - signedUpCents);
  return { goalCents, earnedCents, signedUpCents, remainingCents };
}

export type Recommendation = Job & { jobPositionId: string; totalCents: Cents; placement: Interval };

/**
 * Open details the person can sign up for now that fit their duty time, sign-ups and hour caps, chosen to reach
 * the remaining goal. Released, open, not hidden, not restricted, in the current agency month or later (next 60
 * days). Nothing is reserved; the person still signs up first come, first served.
 */
export async function recommendationsFor(actor: Actor, tx: Tx, now: Date): Promise<Recommendation[]> {
  assertOwn(actor);
  const progress = await goalProgress(actor, tx, now);
  if (progress.goalCents === null || progress.remainingCents <= 0) return [];
  const settings = await getSettings(tx);
  const from = new Date(Math.max(now.getTime(), agencyMonth(now).start.getTime()));
  const to = new Date(now.getTime() + RECOMMENDATION_DAYS * DAY_MS);

  const hidden = tx.select({ id: hiddenVendors.vendorId }).from(hiddenVendors).where(eq(hiddenVendors.userId, actor.userId));
  const restricted = tx.select({ id: vendorRestrictions.vendorId }).from(vendorRestrictions).where(and(eq(vendorRestrictions.userId, actor.userId), isNull(vendorRestrictions.liftedAt)));
  const mine = tx
    .select({ id: assignments.jobId })
    .from(assignments)
    .where(and(eq(assignments.userId, actor.userId), notInArray(assignments.status, ["canceled", "removed"])));
  const rows = await tx
    .select({ job: jobs, vendorMinimum: vendors.minimumBillableMinutes })
    .from(jobs)
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(
      and(
        inArray(jobs.state, [...APPROVED_STATES]),
        eq(jobs.held, false),
        lte(jobs.releaseAt, now),
        gt(jobs.startAt, from),
        lte(jobs.startAt, to),
        eq(vendors.active, true),
        eq(vendors.paymentHold, false),
        notInArray(jobs.vendorId, hidden),
        notInArray(jobs.vendorId, restricted),
        notInArray(jobs.id, mine),
      ),
    )
    .orderBy(asc(jobs.startAt), asc(jobs.number))
    .limit(MAX_CANDIDATES);

  // Hours that count toward caps, as in the sign-up check: held spots and finished details, plus schedule shifts when the agency counts them.
  const lo = new Date(from.getTime() - 32 * DAY_MS);
  const hi = new Date(to.getTime() + 32 * DAY_MS);
  const held = await tx
    .select({ a: assignments, jobStart: jobs.startAt, jobEnd: jobs.endAt })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(and(eq(assignments.userId, actor.userId), inArray(assignments.status, ["pending_short", "signed_up", "billed", "paid"]), gte(jobs.startAt, lo), lte(jobs.startAt, hi)));
  const spans = held.map((h) => ({ status: h.a.status, startAt: h.a.plannedStartAt ?? h.jobStart, endAt: h.a.plannedEndAt ?? h.jobEnd }));
  const capExisting: Interval[] = spans.map(({ startAt, endAt }) => ({ startAt, endAt }));
  if (settings.capHoursMode === "details_plus_schedule") capExisting.push(...(await scheduleShiftsForCaps(tx, actor.userId, lo, hi)));
  const seasonRows = await tx.select().from(seasons);
  const capCheck = (picked: Interval[]) =>
    evaluateCaps({
      existing: [...capExisting, ...picked.slice(0, -1)],
      candidate: picked[picked.length - 1],
      seasons: seasonRows,
      weekStartsOn: settings.weekStartsOn,
      rollingWindowHours: settings.rollingCapWindowHours,
    }).every((c) => c.ok);

  const existing = spans.filter((s) => s.status === "signed_up" || s.status === "pending_short").map(({ startAt, endAt }) => ({ startAt, endAt }));
  const duty = await loadDuty(tx, actor.userId, new Date(from.getTime() - DAY_MS), new Date(to.getTime() + 2 * DAY_MS));
  const blockers: Blockers = { existing, duty, capCheck };

  // Soonest first. The cheap checks (placement, caps) come first; the full eligibility check runs only for the
  // detail about to be picked, and the walk stops once the remaining goal is reached.
  const picks: Recommendation[] = [];
  const placements: Interval[] = [];
  let total = 0;
  for (const { job, vendorMinimum } of rows) {
    if (total >= progress.remainingCents) break;
    const flex = job.flexEarliestStartAt && job.flexLatestEndAt ? { earliestStartAt: job.flexEarliestStartAt, latestEndAt: job.flexLatestEndAt, allowShorter: job.flexAllowShorter } : null;
    const placement = place(blockers, placements, { startAt: job.startAt, endAt: job.endAt, flex });
    if (!placement) continue;
    let e;
    try {
      e = await eligibilityFor(actor, tx, job.id, now);
    } catch (err) {
      if (err instanceof NotFoundError) continue;
      throw err;
    }
    if (!e.canSignUp) continue;
    const [pos] = await tx.select({ differential: jobPositions.rateDifferentialCents }).from(jobPositions).where(eq(jobPositions.id, e.jobPositionId));
    const rateCents = positionRateCents(job.rateCents, { rateDifferentialCents: pos?.differential ?? 0 });
    const totalCents = scheduledPayCents({ ...job, rateCents }, vendorMinimum, settings, job);
    // The rate shown with the pick is the position's own rate.
    // A reactivated detail keeps its cancel fields for billing; the person is not told who canceled it or why.
    picks.push({ ...jobFieldsFor(actor, job), rateCents, jobPositionId: e.jobPositionId, totalCents, placement });
    placements.push(placement);
    total += totalCents;
  }
  return picks;
}
