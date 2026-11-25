import { and, asc, count, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { qualificationRequests, qualifications, userQualifications, users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, RuleViolation, ValidationError } from "../errors";
import { assertCanTouchRole } from "../users/users";

export type Qualification = typeof qualifications.$inferSelect;
export type UserQualification = typeof userQualifications.$inferSelect;
export type QualificationRequest = typeof qualificationRequests.$inferSelect;

/** Flags on an admin account are changed only by admins, like the rest of that account. */
async function assertCanTouchUser(actor: Actor, tx: Tx, userId: string): Promise<void> {
  const [user] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!user) throw new NotFoundError("User not found.");
  assertCanTouchRole(actor, user.role);
}

async function getQualification(tx: Tx, id: string): Promise<Qualification> {
  const [row] = await tx.select().from(qualifications).where(eq(qualifications.id, id));
  if (!row) throw new NotFoundError("Qualification not found.");
  return row;
}

async function assertNameFree(tx: Tx, name: string, exceptId?: string) {
  const rows = await tx.select({ id: qualifications.id }).from(qualifications).where(eq(qualifications.name, name));
  if (rows.some((r) => r.id !== exceptId)) throw new ValidationError(`A qualification named "${name}" already exists.`);
}

/** Qualifications (flags) are visible to personnel and above; vendors never see them. */
export function listQualifications(actor: Actor, tx: Tx): Promise<Qualification[]> {
  assertCan(actor, "qualification.request");
  return tx.select().from(qualifications).orderBy(asc(qualifications.name));
}

export async function createQualification(actor: Actor, tx: Tx, input: { name: string }): Promise<Qualification> {
  assertCan(actor, "qualification.manage");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Qualification name is required.");
  await assertNameFree(tx, name);
  const [row] = await tx.insert(qualifications).values({ name }).returning();
  await recordAudit(tx, { actor, action: "qualification.create", entityType: "qualification", entityId: row.id, before: null, after: row });
  return row;
}

export async function renameQualification(actor: Actor, tx: Tx, id: string, input: { name: string }): Promise<Qualification> {
  assertCan(actor, "qualification.manage");
  const before = await getQualification(tx, id);
  const name = input.name.trim();
  if (!name) throw new ValidationError("Qualification name is required.");
  await assertNameFree(tx, name, id);
  const [after] = await tx.update(qualifications).set({ name }).where(eq(qualifications.id, id)).returning();
  await recordAudit(tx, { actor, action: "qualification.update", entityType: "qualification", entityId: id, before, after });
  return after;
}

/** Position types and people reference qualifications, so they are turned off, never deleted. */
export async function setQualificationActive(actor: Actor, tx: Tx, id: string, active: boolean): Promise<Qualification> {
  assertCan(actor, "qualification.manage");
  const before = await getQualification(tx, id);
  if (before.active === active) return before;
  const [after] = await tx.update(qualifications).set({ active }).where(eq(qualifications.id, id)).returning();
  await recordAudit(tx, {
    actor,
    action: `qualification.${active ? "activate" : "deactivate"}`,
    entityType: "qualification",
    entityId: id,
    before,
    after,
  });
  return after;
}

async function activeGrant(tx: Tx, userId: string, qualificationId: string): Promise<UserQualification | undefined> {
  const [row] = await tx
    .select()
    .from(userQualifications)
    .where(
      and(
        eq(userQualifications.userId, userId),
        eq(userQualifications.qualificationId, qualificationId),
        isNull(userQualifications.revokedAt),
      ),
    );
  return row;
}

/** Idempotent: a person who already holds the flag keeps their existing grant. */
export async function grantQualification(
  actor: Actor,
  tx: Tx,
  userId: string,
  qualificationId: string,
): Promise<UserQualification> {
  assertCan(actor, "qualification.manage");
  await assertCanTouchUser(actor, tx, userId);
  const qualification = await getQualification(tx, qualificationId);
  if (!qualification.active) throw new ValidationError("This qualification is turned off.");
  const existing = await activeGrant(tx, userId, qualificationId);
  if (existing) return existing;
  const [grant] = await tx
    .insert(userQualifications)
    .values({ userId, qualificationId, grantedBy: actor.userId })
    .returning();
  await recordAudit(tx, {
    actor,
    action: "user.qualification_grant",
    entityType: "user",
    entityId: userId,
    before: null,
    after: grant,
  });
  return grant;
}

/** Sets revokedAt; the grant row is kept as history. */
export async function revokeQualification(
  actor: Actor,
  tx: Tx,
  userId: string,
  qualificationId: string,
): Promise<UserQualification> {
  assertCan(actor, "qualification.manage");
  await assertCanTouchUser(actor, tx, userId);
  const before = await activeGrant(tx, userId, qualificationId);
  if (!before) throw new NotFoundError("This person does not hold that qualification.");
  const [after] = await tx
    .update(userQualifications)
    .set({ revokedAt: new Date() })
    .where(eq(userQualifications.id, before.id))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "user.qualification_revoke",
    entityType: "user",
    entityId: userId,
    before,
    after,
  });
  return after;
}

/** Own flags only. Vendors are refused. */
export function listMyQualifications(actor: Actor, tx: Tx): Promise<UserQualification[]> {
  assertCan(actor, "qualification.request");
  return flagsFor(tx, actor.userId);
}

/** Coordinators and admins only. */
export function listUserQualifications(actor: Actor, tx: Tx, userId: string): Promise<UserQualification[]> {
  assertCan(actor, "qualification.manage");
  return flagsFor(tx, userId);
}

function flagsFor(tx: Tx, userId: string): Promise<UserQualification[]> {
  return tx
    .select()
    .from(userQualifications)
    .where(and(eq(userQualifications.userId, userId), isNull(userQualifications.revokedAt)))
    .orderBy(asc(userQualifications.grantedAt));
}

/** Active people holding an unrevoked flag. Coordinators and admins only. */
export async function qualificationHolderCount(actor: Actor, tx: Tx, qualificationId: string): Promise<number> {
  assertCan(actor, "qualification.manage");
  const [row] = await tx
    .select({ n: count() })
    .from(userQualifications)
    .innerJoin(users, eq(users.id, userQualifications.userId))
    .where(
      and(
        eq(userQualifications.qualificationId, qualificationId),
        isNull(userQualifications.revokedAt),
        eq(users.active, true),
      ),
    );
  return row.n;
}

/**
 * A person asks for a flag on their own account. The pending row is what coordinators see
 * (listPendingQualificationRequests); the alert to coordinators is delivered by Task 26.
 */
export async function requestQualification(
  actor: Actor,
  tx: Tx,
  qualificationId: string,
  note?: string,
): Promise<QualificationRequest> {
  assertCan(actor, "qualification.request");
  const qualification = await getQualification(tx, qualificationId);
  if (!qualification.active) throw new ValidationError("This qualification is turned off.");
  if (await activeGrant(tx, actor.userId, qualificationId)) {
    throw new ValidationError("You already hold this qualification.");
  }
  const [pending] = await tx
    .select({ id: qualificationRequests.id })
    .from(qualificationRequests)
    .where(
      and(
        eq(qualificationRequests.userId, actor.userId),
        eq(qualificationRequests.qualificationId, qualificationId),
        eq(qualificationRequests.status, "pending"),
      ),
    );
  if (pending) throw new ValidationError("You already have a pending request for this qualification.");
  const [row] = await tx
    .insert(qualificationRequests)
    .values({ userId: actor.userId, qualificationId, note: note?.trim() || null })
    .returning();
  await recordAudit(tx, {
    actor,
    action: "qualification_request.create",
    entityType: "qualification_request",
    entityId: row.id,
    before: null,
    after: row,
  });
  return row;
}

export function listPendingQualificationRequests(actor: Actor, tx: Tx): Promise<QualificationRequest[]> {
  assertCan(actor, "qualification.manage");
  return tx
    .select()
    .from(qualificationRequests)
    .where(eq(qualificationRequests.status, "pending"))
    .orderBy(asc(qualificationRequests.createdAt));
}

export function listMyQualificationRequests(actor: Actor, tx: Tx): Promise<QualificationRequest[]> {
  assertCan(actor, "qualification.request");
  return tx
    .select()
    .from(qualificationRequests)
    .where(eq(qualificationRequests.userId, actor.userId))
    .orderBy(asc(qualificationRequests.createdAt));
}

/**
 * Approval grants the flag. The returned row carries the requester (userId), outcome and reason
 * for the alert that Task 26 delivers.
 */
export async function decideQualificationRequest(
  actor: Actor,
  tx: Tx,
  requestId: string,
  decision: { approve: boolean; reason?: string },
): Promise<QualificationRequest> {
  assertCan(actor, "qualification.manage");
  const [before] = await tx.select().from(qualificationRequests).where(eq(qualificationRequests.id, requestId));
  if (!before) throw new NotFoundError("Request not found.");
  if (before.status !== "pending") {
    throw new RuleViolation([{ check: "qualification_request.pending", ok: false, message: "This request was already decided." }]);
  }
  await assertCanTouchUser(actor, tx, before.userId);
  const reason = decision.reason?.trim() || null;
  if (decision.approve) await grantQualification(actor, tx, before.userId, before.qualificationId);
  const [after] = await tx
    .update(qualificationRequests)
    .set({ status: decision.approve ? "approved" : "denied", decidedBy: actor.userId, decidedAt: new Date(), reason })
    .where(eq(qualificationRequests.id, requestId))
    .returning();
  await recordAudit(tx, {
    actor,
    action: decision.approve ? "qualification_request.approve" : "qualification_request.deny",
    entityType: "qualification_request",
    entityId: requestId,
    before,
    after,
    reason: reason ?? undefined,
  });
  return after;
}
