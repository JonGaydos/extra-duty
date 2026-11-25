import { createHash } from "node:crypto";
import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, users } from "@/db/schema";
import type { Actor } from "../actor";
import { buildContext, loadPosition } from "../assignments/signup";
import { evaluateSignup } from "../eligibility/eligibility";
import { RuleViolation, ValidationError, type CheckResult } from "../errors";
import type { AgencySettings } from "../settings/settings";
import type { Job } from "./jobs";

/**
 * Owner decision (Task 39a): when a detail's times change, every deputy holding a spot is checked again against
 * their other details (overlap) and their hour caps, with the eligibility engine's own checks and messages. A
 * conflict refuses the edit until it is resolved (the deputy removed, or the edit changed) or a coordinator
 * overrides it with a reason, which is audited.
 */

export type ScheduleConflict = {
  assignmentId: string;
  userId: string;
  name: string;
  jobId: string;
  jobNumber: number;
  title: string;
  startAt: Date;
  /** `schedule.window`: a flexible detail's new window no longer holds the person's planned shift. */
  check: "overlap" | "cap_rolling" | "cap_week" | "cap_month" | "schedule.window";
  message: string;
};

const CONFLICT_CHECKS = new Set<string>(["overlap", "cap_rolling", "cap_week", "cap_month"]);
const HOLDING = ["signed_up", "pending_short"] as const;
const CLOCK = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", minute: "2-digit" });

/** Only coordinators and admins (who hold coordinator powers) may override a conflict. */
export const canOverrideConflicts = (actor: Actor) => actor.role === "coordinator" || actor.role === "admin";

export const MAX_CONFLICT_REASON = 500;

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", weekday: "short", month: "short", day: "numeric" });

/** "Riley Signed on #12, Tue, Dec 8: Overlaps job #13": the deputy, the detail and the engine's exact message. */
export const conflictText = (c: ScheduleConflict) => `${c.name} on #${c.jobNumber}, ${DAY.format(c.startAt)}: ${c.message}`;

/**
 * A short fingerprint of one detail's conflict set. The screen echoes it back with an override, so the override
 * covers exactly the conflicts the coordinator was shown; any other set is refused.
 */
export function conflictFingerprint(conflicts: ScheduleConflict[]): string {
  const key = conflicts.map((c) => `${c.assignmentId}|${c.check}|${c.message}`).sort().join("\n");
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

/** A coordinator's override of the conflicts shown for one detail. */
export type ConflictOverride = { reason: string; fingerprint: string };

export class ScheduleConflictError extends RuleViolation {
  readonly conflicts: ScheduleConflict[];
  /** Per detail id, the fingerprint an override must echo back. */
  readonly fingerprints: Record<string, string>;
  constructor(conflicts: ScheduleConflict[]) {
    super(
      conflicts.map((c): CheckResult => ({ check: c.check, ok: false, message: conflictText(c) })),
      `${conflicts.length === 1 ? "1 deputy conflict" : `${conflicts.length} deputy conflicts`}: ${conflicts.map((c) => `${c.name}, #${c.jobNumber}: ${c.message}`).join(". ")}. Remove the deputy, change the edit, or override with a reason.`,
    );
    this.conflicts = conflicts;
    const byJob = new Map<string, ScheduleConflict[]>();
    for (const c of conflicts) byJob.set(c.jobId, [...(byJob.get(c.jobId) ?? []), c]);
    this.fingerprints = Object.fromEntries([...byJob].map(([id, list]) => [id, conflictFingerprint(list)]));
    this.fields = this.fingerprints;
  }
}

/** Overlap and cap conflicts for the people holding a spot if `job` ran at its (new) times. */
export async function conflictsAt(tx: Tx, job: Job, settings: AgencySettings, now: Date): Promise<ScheduleConflict[]> {
  const rows = await tx
    .select({ a: assignments, name: users.name })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(eq(assignments.jobId, job.id), inArray(assignments.status, [...HOLDING])))
    .orderBy(asc(users.name), asc(assignments.id));
  const out: ScheduleConflict[] = [];
  const flex = job.flexEarliestStartAt !== null && job.flexLatestEndAt !== null;
  for (const { a, name } of rows) {
    // A flexible detail keeps each person's planned shift; a fixed one moves everyone to the new times.
    const planned = flex && a.plannedStartAt && a.plannedEndAt ? { startAt: a.plannedStartAt, endAt: a.plannedEndAt } : { startAt: job.startAt, endAt: job.endAt };
    if (flex && (planned.startAt.getTime() < job.flexEarliestStartAt!.getTime() || planned.endAt.getTime() > job.flexLatestEndAt!.getTime())) {
      out.push({
        assignmentId: a.id,
        userId: a.userId,
        name,
        jobId: job.id,
        jobNumber: job.number,
        title: job.title,
        startAt: job.startAt,
        check: "schedule.window",
        message: `Planned shift ${CLOCK.format(planned.startAt)} to ${CLOCK.format(planned.endAt)} is outside the new flexible window`,
      });
    }
    const position = await loadPosition(tx, a.jobPositionId);
    const ctx = await buildContext(tx, { userId: a.userId, job, position, free: 1, planned, now, settings, includePending: true, excludeAssignmentId: a.id });
    for (const c of evaluateSignup(ctx).checks) {
      if (c.ok || !CONFLICT_CHECKS.has(c.check)) continue;
      out.push({ assignmentId: a.id, userId: a.userId, name, jobId: job.id, jobNumber: job.number, title: job.title, startAt: job.startAt, check: c.check as ScheduleConflict["check"], message: c.message });
    }
  }
  return out;
}

/**
 * The override reason to use, or null when the actor may not override, gave no reason, or the fingerprint does not
 * match the conflicts now found (the coordinator was shown a different set).
 */
export function overrideReason(actor: Actor, conflicts: ScheduleConflict[], override: ConflictOverride | null | undefined): string | null {
  const why = override?.reason?.trim();
  if (!why || !canOverrideConflicts(actor)) return null;
  if (why.length > MAX_CONFLICT_REASON) throw new ValidationError(`Keep the reason to ${MAX_CONFLICT_REASON} characters.`);
  return override!.fingerprint === conflictFingerprint(conflicts) ? why : null;
}
