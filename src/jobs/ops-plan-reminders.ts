import { and, asc, desc, eq, gt, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { withTx } from "@/db/client";
import { jobs, opsPlanAlerts, opsPlanVersions, opsPlans } from "@/db/schema";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";
import { currentIcInfo, opsPlanDueAt, eligibleReviewers } from "@/domain/ops-plans/ops-plans";
import { agencyDayKey } from "@/domain/time/agency-time";

/** Elapsed time, wider than 24 h so a 25-hour DST day between daily ticks cannot skip the alert; the marker prevents repeats. */
const DUE_SOON_MS = 26 * 3_600_000;

/** One failing job is logged and skipped so it cannot block the rest of the tick. */
async function guarded(what: string, fn: () => Promise<number>): Promise<number> {
  try {
    return await fn();
  } catch (err) {
    console.error(`Failed ${what}:`, err);
    return 0;
  }
}

/** Claims an alert marker. True only for the first caller; the unique (job, kind, key) makes a repeat a no-op. */
async function claim(tx: Tx, jobId: string, kind: string, key: string, now: Date): Promise<boolean> {
  const rows = await tx.insert(opsPlanAlerts).values({ jobId, kind, key, sentAt: now }).onConflictDoNothing().returning({ id: opsPlanAlerts.id });
  return rows.length > 0;
}

/**
 * Daily tick (7:40 AM agency time). For each open job that needs an ops plan with no plan yet (or a denied one):
 * the IC and coordinators get `ops_plan.due_soon` within about a day of the due date and `ops_plan.overdue` once it
 * has passed, each once per due date (a new IC with a new due date is alerted afresh). Then, for each plan whose
 * latest version is unreviewed, the reviewers (never the submitting IC) get `ops_plan.review_waiting` once per
 * agency day. Returns the number of alerts sent.
 */
export async function opsPlanRemindersTick(now: Date): Promise<number> {
  const needing = await withTx((tx) =>
    tx
      .select({ id: jobs.id })
      .from(jobs)
      .where(and(eq(jobs.opsPlanRequired, true), inArray(jobs.state, ["requested", "scheduled", "active"]), gt(jobs.endAt, now)))
      .orderBy(asc(jobs.id)),
  );
  let sent = 0;
  // Sequential: one transaction per job, so one failure is skipped without holding many connections.
  for (const { id } of needing) {
    sent += await guarded(`ops plan due alerts for job ${id}`, () => withTx((tx) => dueAlerts(tx, id, now)));
  }
  const waiting = await withTx((tx) =>
    tx
      .select({ id: opsPlans.id })
      .from(opsPlans)
      .innerJoin(jobs, eq(jobs.id, opsPlans.jobId))
      .where(and(eq(opsPlans.status, "submitted"), inArray(jobs.state, ["requested", "scheduled", "active"])))
      .orderBy(asc(opsPlans.id)),
  );
  // Sequential: one transaction per plan, for the same reason.
  for (const { id } of waiting) {
    sent += await guarded(`ops plan review reminder for plan ${id}`, () => withTx((tx) => reviewAlerts(tx, id, now)));
  }
  return sent;
}

const DUE_ALERT = {
  overdue: { type: "ops_plan.overdue", title: "Ops plan overdue", state: "overdue" },
  due_soon: { type: "ops_plan.due_soon", title: "Ops plan due soon", state: "due soon" },
} as const;

/** Overdue once the due time has passed, due soon within DUE_SOON_MS of it, else no alert yet. */
function dueAlertKind(now: Date, dueAt: Date): keyof typeof DUE_ALERT | null {
  if (now.getTime() >= dueAt.getTime()) return "overdue";
  return now.getTime() >= dueAt.getTime() - DUE_SOON_MS ? "due_soon" : null;
}

async function dueAlerts(tx: Tx, jobId: string, now: Date): Promise<number> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job?.opsPlanRequired) return 0;
  const [plan] = await tx.select({ status: opsPlans.status }).from(opsPlans).where(eq(opsPlans.jobId, jobId));
  if (plan && (plan.status === "submitted" || plan.status === "agreed")) return 0;
  const ic = await currentIcInfo(tx, jobId);
  const dueAt = ic ? opsPlanDueAt(job, ic.assignedAt) : job.opsPlanDueAt;
  if (!dueAt) return 0;
  const kind = dueAlertKind(now, dueAt);
  if (!kind) return 0;
  if (!(await claim(tx, jobId, kind, dueAt.toISOString(), now))) return 0;
  const recipients = [...new Set([...(ic ? [ic.userId] : []), ...(await coordinatorAudience(tx))])];
  const alert = DUE_ALERT[kind];
  const noIc = ic ? "" : " and the detail has no Incident Commander";
  await emit(
    tx,
    {
      recipients,
      type: alert.type,
      title: `${alert.title}: job #${job.number}`,
      body: `${job.title}: the ops plan is ${alert.state}${noIc}.`,
      link: `/jobs/${jobId}`,
    },
    now,
  );
  return 1;
}

async function reviewAlerts(tx: Tx, planId: string, now: Date): Promise<number> {
  const [plan] = await tx.select().from(opsPlans).where(eq(opsPlans.id, planId)).for("update");
  if (!plan?.jobId || plan.status !== "submitted") return 0;
  const [open] = await tx.select({ state: jobs.state }).from(jobs).where(eq(jobs.id, plan.jobId));
  if (!open || !["requested", "scheduled", "active"].includes(open.state)) return 0;
  const [version] = await tx
    .select()
    .from(opsPlanVersions)
    .where(eq(opsPlanVersions.opsPlanId, planId))
    .orderBy(desc(opsPlanVersions.submittedAt), desc(opsPlanVersions.id))
    .limit(1);
  if (version?.decision !== "pending") return 0;
  if (!(await claim(tx, plan.jobId, "review_waiting", `${version.id}:${agencyDayKey(now)}`, now))) return 0;
  const reviewers = await eligibleReviewers(tx, plan.jobId, version.submittedBy);
  if (reviewers.length === 0) return 0;
  const [job] = await tx.select({ number: jobs.number, title: jobs.title }).from(jobs).where(eq(jobs.id, plan.jobId));
  await emit(
    tx,
    {
      recipients: reviewers,
      type: "ops_plan.review_waiting",
      title: `Ops plan waiting for review: job #${job.number}`,
      body: `${job.title} has an ops plan that has not been reviewed.`,
      link: `/jobs/${plan.jobId}`,
    },
    now,
  );
  return 1;
}
