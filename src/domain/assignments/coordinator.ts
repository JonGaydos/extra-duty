import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, jobs, spotOffers, vendorRestrictions } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { assignmentVendorId, positionVendorId } from "../auth/scope";
import { evaluateSignup } from "../eligibility/eligibility";
import { NotFoundError, RuleViolation, ValidationError, type CheckResult } from "../errors";
import { getSettings } from "../settings/settings";
import { expireOffer, leaveAssignment } from "./backups";
import { isRestricted } from "./restrictions";
import { FULL_CHECK, buildContext, endOpenWatches, failing, insertAssignment, loadLocked, lockUser, settlePending, signedUpCount, type Assignment } from "./signup";
import { emit } from "../notifications/notify";


export type VendorRestriction = typeof vendorRestrictions.$inferSelect;

const RESTRICTED_ABSOLUTE = "Restricted people cannot be assigned, even with an override.";

/** Puts a person in a position. Failing checks need `overrideReason`; a vendor restriction cannot be overridden. */
export async function assignPerson(
  actor: Actor,
  tx: Tx,
  jobPositionId: string,
  userId: string,
  opts: { overrideReason?: string; notify: boolean; now?: Date },
): Promise<Assignment> {
  assertCan(actor, "assignment.assign", { vendorId: await positionVendorId(tx, jobPositionId) });
  const now = opts.now ?? new Date();
  const override = opts.overrideReason?.trim() || undefined;
  await lockUser(tx, userId);
  const { position, job } = await loadLocked(tx, jobPositionId);
  const settings = await getSettings(tx);
  await settlePending(tx, job, settings, now);

  const free = position.count - (await signedUpCount(tx, position.id));
  const planned = { startAt: job.startAt, endAt: job.endAt };
  const problems: CheckResult[] = failing(
    evaluateSignup(await buildContext(tx, { userId, job, position, free, planned, now, settings, includePending: true })),
  );
  if (free <= 0) problems.push(FULL_CHECK);
  if (problems.some((c) => c.check === "vendor_restricted")) {
    throw new RuleViolation(problems, RESTRICTED_ABSOLUTE);
  }
  if (problems.some((c) => c.check === "already_on_job")) throw new RuleViolation(problems);
  if (problems.length > 0 && !override) throw new RuleViolation(problems);

  const row = await insertAssignment(tx, {
    jobId: job.id,
    jobPositionId: position.id,
    userId,
    status: "signed_up",
    requestedAt: now,
    plannedStartAt: planned.startAt,
    plannedEndAt: planned.endAt,
    overrideReason: problems.length > 0 ? override : null,
  });
  await recordAudit(tx, {
    actor,
    action: "assignment.assign",
    entityType: "assignment",
    entityId: row.id,
    before: null,
    // An override names every rule it went past (overlap, caps and the rest) in the engine's own words.
    after: problems.length > 0 ? { ...row, overridden: problems.map((c) => ({ check: c.check, message: c.message })) } : row,
    reason: problems.length > 0 ? override : undefined,
  });
  await endOpenWatches(tx, actor, job.id, now, userId);
  // Offers beyond the remaining free spots end, newest first; their backups are told.
  const open = await tx
    .select()
    .from(spotOffers)
    .where(and(eq(spotOffers.jobPositionId, position.id), eq(spotOffers.status, "open")))
    .orderBy(asc(spotOffers.createdAt), asc(spotOffers.id));
  const surplus = open.length - Math.max(free - 1, 0);
  // Sequential: expiries and alerts written in this transaction.
  for (const o of open.slice(open.length - Math.max(surplus, 0))) {
    await expireOffer(tx, o, "expired");
    const who = o.offeredToAssignmentId
      ? await tx.select({ userId: assignments.userId }).from(assignments).where(eq(assignments.id, o.offeredToAssignmentId))
      : await tx
          .select({ userId: assignments.userId })
          .from(assignments)
          .where(and(eq(assignments.jobPositionId, position.id), eq(assignments.status, "backup")));
    await emit(tx, {
      recipients: who.map((w) => w.userId),
      type: "spot.offer_ended",
      title: `Spot no longer available: #${job.number} ${job.title}`,
      body: `The spot for ${position.name} was filled by a coordinator.`,
      link: `/jobs/${job.id}`,
    });
  }
  if (opts.notify) {
    await emit(tx, { recipients: [userId],
      type: "assignment.assigned",
      mandatory: true,
      title: `You were assigned: #${job.number} ${job.title}`,
      body: `A coordinator assigned you to ${position.name}.`,
      link: `/jobs/${job.id}`,
    });
  }
  return row;
}

export async function removePerson(actor: Actor, tx: Tx, assignmentId: string, comment: string, now: Date = new Date()): Promise<Assignment> {
  assertCan(actor, "assignment.remove", { vendorId: await assignmentVendorId(tx, assignmentId) });
  const why = comment?.trim();
  if (!why) throw new ValidationError("A comment is required.");
  const after = await leaveAssignment(actor, tx, assignmentId, {
    status: "removed",
    auditAction: "assignment.remove",
    reason: why,
    removalReason: why,
    notifyBody: why,
    now,
  });
  return after;
}

export async function markNoShow(actor: Actor, tx: Tx, assignmentId: string, note: string, now: Date = new Date()): Promise<Assignment> {
  assertCan(actor, "assignment.noShow");
  const why = note?.trim();
  if (!why) throw new ValidationError("A note is required.");
  const [first] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (!first) throw new NotFoundError("Assignment not found.");
  await lockUser(tx, first.userId);
  const { job } = await loadLocked(tx, first.jobPositionId);
  const [before] = await tx.select().from(assignments).where(eq(assignments.id, assignmentId));
  if (before.status !== "signed_up") throw new ValidationError("Only a signed-up person can be marked as a no-show.");
  if (now.getTime() < job.startAt.getTime()) throw new ValidationError("The detail has not started.");
  const [after] = await tx.update(assignments).set({ status: "no_show", updatedAt: now }).where(eq(assignments.id, assignmentId)).returning();
  await recordAudit(tx, { actor, action: "assignment.no_show", entityType: "assignment", entityId: assignmentId, before, after, reason: why });
  return after;
}

export async function restrictFromVendor(
  actor: Actor,
  tx: Tx,
  userId: string,
  vendorId: string,
  opts: { reason: string; removeFromFutureDetails: boolean; now?: Date },
): Promise<VendorRestriction> {
  assertCan(actor, "vendorRestriction.manage");
  const why = opts.reason?.trim();
  if (!why) throw new ValidationError("A reason is required.");
  const now = opts.now ?? new Date();
  await lockUser(tx, userId);
  if (await isRestricted(tx, userId, vendorId)) throw new ValidationError("This person is already restricted from this vendor.");
  const [row] = await tx.insert(vendorRestrictions).values({ userId, vendorId, reason: why, createdBy: actor.userId }).returning();
  await recordAudit(tx, { actor, action: "vendor_restriction.create", entityType: "vendor_restriction", entityId: row.id, before: null, after: row, reason: why });

  if (opts.removeFromFutureDetails) {
    const future = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .innerJoin(jobs, eq(jobs.id, assignments.jobId))
      .where(
        and(
          eq(assignments.userId, userId),
          eq(jobs.vendorId, vendorId),
          inArray(assignments.status, ["signed_up", "backup", "pending_short"]),
          gt(jobs.startAt, now),
        ),
      )
      .orderBy(asc(assignments.jobId), asc(assignments.id));
    // Sequential: each sign-up is ended in this transaction, in order.
    for (const a of future) {
      await leaveAssignment(actor, tx, a.id, {
        status: "removed",
        auditAction: "assignment.remove",
        reason: `Restricted: ${why}`,
        removalReason: `Restricted: ${why}`,
        notifyBody: "A coordinator removed you from this detail.",
        now,
      });
    }
  }
  return row;
}

export async function liftVendorRestriction(actor: Actor, tx: Tx, restrictionId: string, note?: string, now: Date = new Date()): Promise<VendorRestriction> {
  assertCan(actor, "vendorRestriction.manage");
  const [before] = await tx.select().from(vendorRestrictions).where(eq(vendorRestrictions.id, restrictionId));
  if (!before) throw new NotFoundError("Restriction not found.");
  if (before.liftedAt) throw new ValidationError("This restriction is already lifted.");
  const [after] = await tx
    .update(vendorRestrictions)
    .set({ liftedAt: now, liftedBy: actor.userId })
    .where(and(eq(vendorRestrictions.id, restrictionId), isNull(vendorRestrictions.liftedAt)))
    .returning();
  await recordAudit(tx, { actor, action: "vendor_restriction.lift", entityType: "vendor_restriction", entityId: restrictionId, before, after, reason: note?.trim() || undefined });
  return after;
}
