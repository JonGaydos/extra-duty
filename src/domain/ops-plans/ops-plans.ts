import { and, asc, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  assignments,
  files,
  jobPositions,
  jobs,
  opsPlanVersions,
  opsPlans,
  positionTypes,
  qualifications,
  userQualifications,
  vendorLocations,
} from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { readStoredFile, storeFile, type FileRow } from "@/domain/files/files";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";
import { HIDDEN_FROM_PERSONNEL } from "@/domain/jobs/jobs";
import { getSettings } from "@/domain/settings/settings";
import { agencyDateParts } from "@/domain/time/agency-time";
import type { Storage } from "@/lib/storage";

export type OpsPlanVersion = typeof opsPlanVersions.$inferSelect;
/** Per job: `not_started` has no plan row yet; `denied` means the IC must resubmit. */
type OpsPlanJobStatus = "not_started" | "submitted" | "agreed" | "denied";

const IC_QUALIFICATION = "Incident Commander";
const UPLOAD_TYPES = ["pdf", "docx", "doc"] as const;

export type OpsPlanFile = { filename: string; contentType: string; body: Buffer };

export type IcInfo = { userId: string; assignedAt: Date };

/**
 * The job's Incident Commander: the person signed up for a position whose type is an IC position,
 * else the roster member a coordinator named (the flagged assignment). Null when neither exists.
 */
async function positionIcInfo(tx: Tx, jobId: string): Promise<IcInfo | null> {
  const [r] = await tx
    .select({ userId: assignments.userId, createdAt: assignments.createdAt, icAssignedAt: assignments.icAssignedAt })
    .from(assignments)
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(and(eq(assignments.jobId, jobId), eq(assignments.status, "signed_up"), eq(positionTypes.isIncidentCommander, true)))
    .orderBy(asc(assignments.createdAt), asc(assignments.id))
    .limit(1);
  return r ? { userId: r.userId, assignedAt: r.icAssignedAt ?? r.createdAt } : null;
}

export async function currentIcInfo(tx: Tx, jobId: string): Promise<IcInfo | null> {
  const position = await positionIcInfo(tx, jobId);
  if (position) return position;
  const flagged = await tx
        .select({ userId: assignments.userId, createdAt: assignments.createdAt, icAssignedAt: assignments.icAssignedAt })
        .from(assignments)
        .where(and(eq(assignments.jobId, jobId), eq(assignments.status, "signed_up"), eq(assignments.isIncidentCommander, true)))
        .orderBy(asc(assignments.createdAt), asc(assignments.id))
        .limit(1);
  const r = flagged[0];
  return r ? { userId: r.userId, assignedAt: r.icAssignedAt ?? r.createdAt } : null;
}

export async function currentIc(tx: Tx, jobId: string): Promise<string | null> {
  return (await currentIcInfo(tx, jobId))?.userId ?? null;
}

/**
 * Coordinator names a roster member as Incident Commander. The person must be signed up and hold the
 * Incident Commander qualification. Any earlier named IC on the job is cleared.
 */
export async function nameIc(actor: Actor, tx: Tx, jobId: string, userId: string, now: Date = new Date()): Promise<void> {
  assertCan(actor, "job.update");
  const [job] = await tx.select({ id: jobs.id, state: jobs.state }).from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job) throw new NotFoundError("Job not found.");
  const roster = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobId, jobId), eq(assignments.userId, userId), eq(assignments.status, "signed_up")));
  if (roster.length === 0) throw new ValidationError("The Incident Commander must be signed up for this detail.");
  const [qual] = await tx
    .select({ id: userQualifications.id })
    .from(userQualifications)
    .innerJoin(qualifications, eq(qualifications.id, userQualifications.qualificationId))
    .where(and(eq(userQualifications.userId, userId), isNull(userQualifications.revokedAt), eq(qualifications.name, IC_QUALIFICATION)))
    .limit(1);
  if (!qual) throw new ValidationError("This person does not hold the Incident Commander qualification.");
  const holder = await positionIcInfo(tx, jobId);
  if (holder && holder.userId !== userId) throw new ValidationError("An Incident Commander position is filled; remove that person first.");
  const before = await currentIc(tx, jobId);
  await tx.update(assignments).set({ isIncidentCommander: false }).where(and(eq(assignments.jobId, jobId), eq(assignments.isIncidentCommander, true)));
  await tx.update(assignments).set({ isIncidentCommander: true, icAssignedAt: now }).where(eq(assignments.id, roster[0].id));
  await recordAudit(tx, { actor, action: "ops_plan.name_ic", entityType: "job", entityId: jobId, before: { incidentCommander: before }, after: { incidentCommander: userId } });
}

/**
 * When the Incident Commander's plan is due: the job's due date, or the detail's start when the IC was
 * assigned after the due date (they would otherwise be overdue on arrival). A job with no due date is due at start.
 */
export function opsPlanDueAt(job: { startAt: Date; opsPlanDueAt: Date | null }, icAssignedAt: Date): Date {
  if (!job.opsPlanDueAt) return job.startAt;
  return icAssignedAt.getTime() > job.opsPlanDueAt.getTime() ? job.startAt : job.opsPlanDueAt;
}

async function latestVersion(tx: Tx, planId: string): Promise<OpsPlanVersion | null> {
  const [v] = await tx
    .select()
    .from(opsPlanVersions)
    .where(eq(opsPlanVersions.opsPlanId, planId))
    .orderBy(desc(opsPlanVersions.submittedAt), desc(opsPlanVersions.id))
    .limit(1);
  return v ?? null;
}

/** Who may review a plan: the settings list, minus the person who submitted the version and the job's current IC. */
export async function eligibleReviewers(tx: Tx, jobId: string | null, submitterId: string | null): Promise<string[]> {
  const s = await getSettings(tx);
  const ic = jobId ? await currentIc(tx, jobId) : null;
  return s.opsPlanReviewerUserIds.filter((id) => id !== submitterId && id !== ic);
}

/**
 * The current IC submits a plan file (PDF, DOCX or DOC, at most 20 MB). Creates the plan on first
 * submission and a new version each time; the plan becomes `submitted` and needs review again, also after
 * an earlier agreement. Reviewers are alerted; with none set, coordinators are told instead.
 */
export async function submitOpsPlan(actor: Actor, tx: Tx, jobId: string, file: OpsPlanFile, storage?: Storage, now: Date = new Date()): Promise<OpsPlanVersion> {
  assertCan(actor, "opsPlan.submit");
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job) throw new NotFoundError("Job not found.");
  if ((await currentIc(tx, jobId)) !== actor.userId) throw new ForbiddenError("Only the Incident Commander can submit the ops plan.");
  if (!job.opsPlanRequired) throw new ValidationError("This detail does not need an ops plan.");
  if (job.state === "canceled" || job.state === "declined") throw new ValidationError("This detail is closed.");

  const stored = await storeFile(actor, tx, { kind: "ops_plan", ...file }, { only: UPLOAD_TYPES }, storage);

  let [plan] = await tx.select().from(opsPlans).where(eq(opsPlans.jobId, jobId)).for("update");
  const before = plan ? { status: plan.status } : null;
  if (!plan) {
    const [loc] = job.locationId ? await tx.select({ name: vendorLocations.name }).from(vendorLocations).where(eq(vendorLocations.id, job.locationId)) : [];
    [plan] = await tx
      .insert(opsPlans)
      .values({ jobId, vendorId: job.vendorId, eventName: job.title, year: agencyDateParts(job.startAt).year, location: loc?.name ?? null, status: "submitted" })
      .returning();
  } else {
    [plan] = await tx.update(opsPlans).set({ status: "submitted" }).where(eq(opsPlans.id, plan.id)).returning();
  }
  const prior = await tx.select({ id: opsPlanVersions.id }).from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, plan.id));
  const [version] = await tx
    .insert(opsPlanVersions)
    .values({ opsPlanId: plan.id, fileId: stored.id, submittedBy: actor.userId, submittedAt: now })
    .returning();
  await recordAudit(tx, {
    actor,
    action: "ops_plan.submit",
    entityType: "ops_plan",
    entityId: plan.id,
    before,
    after: { status: "submitted", versionId: version.id, version: prior.length + 1, fileId: stored.id },
  });

  const link = `/jobs/${jobId}`;
  const resubmitted = prior.length > 0;
  const reviewers = await eligibleReviewers(tx, jobId, actor.userId);
  if (reviewers.length > 0) {
    await emit(
      tx,
      {
        recipients: reviewers,
        type: resubmitted ? "ops_plan.resubmitted" : "ops_plan.submitted",
        title: `${resubmitted ? "Ops plan resubmitted" : "Ops plan submitted"}: job #${job.number}`,
        body: `${job.title} has an ops plan waiting for your review.`,
        link,
      },
      now,
    );
  } else {
    await emit(
      tx,
      {
        recipients: await coordinatorAudience(tx),
        type: "ops_plan.no_reviewers",
        title: `Ops plan needs a reviewer: job #${job.number}`,
        body: `${job.title} has an ops plan, but no one is set to review ops plans. Add a reviewer in settings.`,
        link,
      },
      now,
    );
  }
  return version;
}

/**
 * A reviewer from the settings list agrees to or denies the plan's latest version. Never the person who
 * submitted it. Denying needs comments and sends the plan back to the IC.
 */
export async function reviewOpsPlan(
  actor: Actor,
  tx: Tx,
  opsPlanId: string,
  input: { decision: "agreed" | "denied"; comments: string; versionId?: string },
  now: Date = new Date(),
): Promise<OpsPlanVersion> {
  if (actor.role === "vendor") throw new ForbiddenError();
  const [plan] = await tx.select().from(opsPlans).where(eq(opsPlans.id, opsPlanId)).for("update");
  if (!plan) throw new NotFoundError("Ops plan not found.");
  const settings = await getSettings(tx);
  if (!settings.opsPlanReviewerUserIds.includes(actor.userId)) throw new ForbiddenError("You are not set as an ops plan reviewer.");
  const version = await latestVersion(tx, plan.id);
  if (input.versionId && version && input.versionId !== version.id) throw new ValidationError("A newer version was submitted; review the latest version.");
  if (!version || plan.status !== "submitted" || version.decision !== "pending") throw new ValidationError("This ops plan has no version waiting for review.");
  if (!(await eligibleReviewers(tx, plan.jobId, version.submittedBy)).includes(actor.userId)) throw new ForbiddenError("You cannot review your own ops plan.");
  const ic = plan.jobId ? await currentIc(tx, plan.jobId) : null;
  const comments = input.comments?.trim() ?? "";
  if (input.decision === "denied" && !comments) throw new ValidationError("Comments are required to deny an ops plan.");

  const [decided] = await tx
    .update(opsPlanVersions)
    .set({ decision: input.decision, decidedBy: actor.userId, decidedAt: now, comments: comments || null })
    .where(eq(opsPlanVersions.id, version.id))
    .returning();
  await tx.update(opsPlans).set({ status: input.decision }).where(eq(opsPlans.id, plan.id));
  await recordAudit(tx, {
    actor,
    action: "ops_plan.review",
    entityType: "ops_plan",
    entityId: plan.id,
    before: { status: "submitted", decision: "pending" },
    after: { status: input.decision, decision: input.decision, versionId: version.id, comments: comments || null },
  });

  if (plan.jobId) {
    const [job] = await tx.select({ number: jobs.number, title: jobs.title }).from(jobs).where(eq(jobs.id, plan.jobId));
    const link = `/jobs/${plan.jobId}`;
    const people = [...new Set([version.submittedBy, ic].filter((x): x is string => !!x))];
    if (input.decision === "denied") {
      await emit(
        tx,
        { recipients: people, type: "ops_plan.denied", title: `Ops plan denied: job #${job.number}`, body: `${job.title}: ${comments} Submit a revised plan.`, link },
        now,
      );
    } else {
      await emit(
        tx,
        {
          recipients: [...new Set([...people, ...(await coordinatorAudience(tx))])],
          type: "ops_plan.agreed",
          title: `Ops plan agreed: job #${job.number}`,
          body: `${job.title}: the ops plan was agreed.`,
          link,
        },
        now,
      );
    }
  }
  return decided;
}

export type JobOpsPlan = {
  status: OpsPlanJobStatus;
  opsPlanId: string | null;
  dueAt: Date | null;
  incidentCommanderId: string | null;
  versions: (OpsPlanVersion & { filename: string })[];
};

/** A job's ops plan state and every version, oldest first. Personnel, coordinators and admins; never vendors. */
export async function getJobOpsPlan(actor: Actor, tx: Tx, jobId: string): Promise<JobOpsPlan> {
  assertCan(actor, "job.read");
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new NotFoundError("Job not found.");
  const [plan] = await tx.select().from(opsPlans).where(eq(opsPlans.jobId, jobId));
  const ic = await currentIcInfo(tx, jobId);
  const versions = plan
    ? await tx
        .select({ v: opsPlanVersions, filename: files.filename })
        .from(opsPlanVersions)
        .innerJoin(files, eq(files.id, opsPlanVersions.fileId))
        .where(eq(opsPlanVersions.opsPlanId, plan.id))
        .orderBy(asc(opsPlanVersions.submittedAt), asc(opsPlanVersions.id))
    : [];
  return {
    status: plan?.status === "due" || !plan ? "not_started" : plan.status,
    opsPlanId: plan?.id ?? null,
    dueAt: ic ? opsPlanDueAt(job, ic.assignedAt) : job.opsPlanDueAt,
    incidentCommanderId: ic?.userId ?? null,
    versions: versions.map((r) => ({ ...r.v, filename: r.filename })),
  };
}

/**
 * Reads one version's file. Personnel, coordinators and admins may read any version; vendors never. Personnel get
 * NotFound for a version whose detail they cannot see (a vendor request not yet approved, or declined).
 */
export async function readOpsPlanVersion(actor: Actor, tx: Tx, versionId: string, storage?: Storage): Promise<{ row: FileRow; body: Buffer }> {
  assertCan(actor, "job.read");
  const [v] = await tx
    .select({ fileId: opsPlanVersions.fileId, jobState: jobs.state })
    .from(opsPlanVersions)
    .innerJoin(opsPlans, eq(opsPlans.id, opsPlanVersions.opsPlanId))
    .leftJoin(jobs, eq(jobs.id, opsPlans.jobId))
    .where(eq(opsPlanVersions.id, versionId));
  if (!v || (actor.role === "personnel" && v.jobState && HIDDEN_FROM_PERSONNEL.includes(v.jobState))) throw new NotFoundError("Ops plan version not found.");
  return readStoredFile(tx, v.fileId, storage);
}
