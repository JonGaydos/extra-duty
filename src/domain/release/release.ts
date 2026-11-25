import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobs, type jobState } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { agencyDateParts, agencyInstant } from "../time/agency-time";

export type JobState = (typeof jobState.enumValues)[number];

export type ReleaseSettings = { releaseDayOfMonth: number; releaseTime: string };

/**
 * Release instant for a detail starting at `detailStart`: `releaseDayOfMonth`
 * at `releaseTime` (agency time) in the previous month, clamped to that
 * month's last day. January details release in December of the prior year.
 */
export function releaseAt(detailStart: Date, s: ReleaseSettings): Date {
  const { year, month } = agencyDateParts(detailStart);
  const relYear = month === 1 ? year - 1 : year;
  const relMonth = month === 1 ? 12 : month - 1;
  const lastDay = new Date(Date.UTC(relYear, relMonth, 0)).getUTCDate();
  const [hour, minute] = s.releaseTime.split(":").map(Number);
  return agencyInstant(relYear, relMonth, Math.min(s.releaseDayOfMonth, lastDay), hour, minute);
}

/**
 * Approved details: `scheduled` is what createJob and approveRequest write; `active` is a legacy synonym kept in the
 * enum. Nothing moves a job between them: an approved detail opens for sign-up by time alone, at releaseAt.
 */
export const APPROVED_STATES = ["scheduled", "active"] as const satisfies readonly JobState[];

export function isApproved(state: JobState): boolean {
  return (APPROVED_STATES as readonly JobState[]).includes(state);
}

/** Open for sign-up: approved, not on hold, and the release time has passed. */
export function isReleased(job: { held: boolean; releaseAt: Date | null; state: JobState }, now: Date): boolean {
  return isApproved(job.state) && !job.held && job.releaseAt !== null && now.getTime() >= job.releaseAt.getTime();
}

/**
 * The release time a reactivated detail returns with, under the normal release rules: a release that already
 * happened (on time or by Release now) stands; otherwise the detail waits for its release time as configured now.
 */
export function restoredReleaseAt(job: { startAt: Date; releaseAt: Date | null }, s: ReleaseSettings, now: Date): Date {
  if (job.releaseAt && job.releaseAt.getTime() <= now.getTime()) return job.releaseAt;
  return releaseAt(job.startAt, s);
}

/**
 * Re-derives releaseAt for jobs that are not yet released (scheduled or
 * active, not started, release still in the future). Returns the count.
 * No notifications are created.
 */
export async function recomputeReleaseDates(
  tx: Tx,
  settings: ReleaseSettings,
  actor: Actor | "system" = "system",
): Promise<number> {
  const now = new Date();
  const rows = await tx
    .select({ id: jobs.id, startAt: jobs.startAt, releaseAt: jobs.releaseAt })
    .from(jobs)
    .where(
      and(
        inArray(jobs.state, ["scheduled", "active"]),
        gt(jobs.startAt, now),
        or(isNull(jobs.releaseAt), gt(jobs.releaseAt, now)),
      ),
    );
  let changed = 0;
  for (const r of rows) {
    const next = releaseAt(r.startAt, settings);
    if (r.releaseAt && r.releaseAt.getTime() === next.getTime()) continue;
    await tx.update(jobs).set({ releaseAt: next }).where(eq(jobs.id, r.id));
    changed++;
  }
  await recordAudit(tx, {
    actor,
    action: "jobs.release_recompute",
    entityType: "jobs",
    entityId: "release-dates",
    after: {
      releaseDayOfMonth: settings.releaseDayOfMonth,
      releaseTime: settings.releaseTime,
      jobsUpdated: changed,
    },
  });
  return changed;
}
