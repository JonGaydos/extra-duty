import { and, asc, eq, gt, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { apiKeys, qualifications, ranks, sessions, userQualifications, users } from "@/db/schema";
import { leaveAssignment } from "../assignments/backups";
import { DEPARTURE_REMOVE_ACTION, LEFT_THE_AGENCY } from "../assignments/history";
import { lockUser } from "../assignments/signup";
import { revokeCalendarTokensFor } from "../planning/ics-feed";
import type { Actor, Role } from "../actor";
import { recordAudit } from "../audit/audit";
import { createInvite } from "../auth/invites";
import { assertCan } from "../auth/policy";
import { normalizeEmail } from "../auth/sign-in-policy";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { cleanChangedPhone, cleanPhone } from "../phone";
import { parseLastDay, signupsAfter, unbilledWork, unpaidInvoices, type DepartureChecklist, type DepartureInvoice, type DepartureSignup, type DepartureUnbilled } from "./departure";

export type User = typeof users.$inferSelect;

const ROLES: readonly Role[] = ["admin", "coordinator", "personnel", "vendor"];

export type CreateUserInput = {
  email: string;
  name: string;
  phone: string | null;
  role: Role;
  rankId: string | null;
  badgeNumber: string | null;
  qualificationIds?: string[];
};

export type UpdateUserInput = Partial<
  Pick<CreateUserInput, "name" | "phone" | "role" | "rankId" | "badgeNumber"> & { mailingAddress: string | null }
>;

/** Only admins may create, change, suspend or deactivate an admin account. */
export function assertCanTouchRole(actor: Actor, targetRole: Role): void {
  if (targetRole === "admin" && actor.role !== "admin") {
    throw new ForbiddenError("Only admins can manage admin accounts.");
  }
}

export async function getUserOrThrow(tx: Tx, id: string): Promise<User> {
  const [row] = await tx.select().from(users).where(eq(users.id, id));
  if (!row) throw new NotFoundError("User not found.");
  return row;
}

async function assertRankExists(tx: Tx, rankId: string | null | undefined): Promise<void> {
  if (!rankId) return;
  const [r] = await tx.select({ id: ranks.id }).from(ranks).where(eq(ranks.id, rankId));
  if (!r) throw new ValidationError("Rank not found.");
}

export async function listUsers(actor: Actor, tx: Tx): Promise<User[]> {
  assertCan(actor, "user.manage");
  return tx.select().from(users).orderBy(asc(users.name));
}

/** Creates the account and emails an invite. Optional qualifications are granted by the creator. */
export async function createUser(actor: Actor, tx: Tx, input: CreateUserInput): Promise<User> {
  assertCan(actor, "user.manage");
  const email = normalizeEmail(input.email);
  if (!email) throw new ValidationError("Email is required.");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Name is required.");
  if (!ROLES.includes(input.role)) throw new ValidationError("Role is not valid.");
  assertCanTouchRole(actor, input.role);
  const [dup] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (dup) throw new ValidationError("An account with this email already exists.");
  await assertRankExists(tx, input.rankId);

  const qualificationIds = [...new Set(input.qualificationIds ?? [])];
  if (qualificationIds.length) {
    const found = await tx
      .select({ id: qualifications.id })
      .from(qualifications)
      .where(inArray(qualifications.id, qualificationIds));
    if (found.length !== qualificationIds.length) throw new ValidationError("Qualification not found.");
  }

  const [row] = await tx
    .insert(users)
    .values({
      email,
      name,
      phone: cleanPhone(input.phone),
      role: input.role,
      rankId: input.rankId,
      badgeNumber: input.badgeNumber,
    })
    .returning();
  await recordAudit(tx, { actor, action: "user.create", entityType: "user", entityId: row.id, before: null, after: row });

  // Sequential: grants and audits written in this transaction.
  for (const qualificationId of qualificationIds) {
    const [grant] = await tx
      .insert(userQualifications)
      .values({ userId: row.id, qualificationId, grantedBy: actor.userId })
      .returning();
    await recordAudit(tx, {
      actor,
      action: "user.qualification_grant",
      entityType: "user",
      entityId: row.id,
      before: null,
      after: grant,
    });
  }

  await createInvite(actor, tx, row.id);
  return row;
}

export async function updateUser(actor: Actor, tx: Tx, id: string, input: UpdateUserInput): Promise<User> {
  assertCan(actor, "user.manage");
  const before = await getUserOrThrow(tx, id);
  assertCanTouchRole(actor, before.role);
  const patch: Partial<typeof users.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ValidationError("Name is required.");
    patch.name = name;
  }
  if (input.role !== undefined) {
    if (!ROLES.includes(input.role)) throw new ValidationError("Role is not valid.");
    assertCanTouchRole(actor, input.role);
    if (before.role === "admin" && input.role !== "admin" && before.active) await assertAnotherAdmin(tx, id);
    patch.role = input.role;
  }
  if (input.rankId !== undefined) {
    await assertRankExists(tx, input.rankId);
    patch.rankId = input.rankId;
  }
  if (input.phone !== undefined) patch.phone = cleanChangedPhone(input.phone, before.phone);
  if (input.badgeNumber !== undefined) patch.badgeNumber = input.badgeNumber;
  if (input.mailingAddress !== undefined) patch.mailingAddress = input.mailingAddress;
  if (!Object.keys(patch).length) return before;

  const [after] = await tx.update(users).set(patch).where(eq(users.id, id)).returning();
  await recordAudit(tx, { actor, action: "user.update", entityType: "user", entityId: id, before, after });
  return after;
}

/**
 * Refuses to leave the agency with no active admin (only admins reach the email server and security settings).
 * The active admin rows are locked, so two admins demoting each other at once cannot both pass.
 */
async function assertAnotherAdmin(tx: Tx, leavingId: string): Promise<void> {
  const admins = await tx.select({ id: users.id }).from(users).where(and(eq(users.role, "admin"), eq(users.active, true))).for("update");
  if (!admins.some((a) => a.id !== leavingId)) throw new ValidationError("At least one active admin is needed. Make someone else an admin first.");
}

export type DeactivateInput = { reason: string; lastDay: string };
export type DeactivationResult = { user: User; removed: DepartureSignup[]; unbilled: DepartureUnbilled[]; unpaid: DepartureInvoice[] };

/** The deactivation checks every caller shares: who may turn whom off, and the required reason and last day. */
async function checkDeparture(actor: Actor, tx: Tx, id: string, input: Partial<DeactivateInput>, now: Date) {
  assertCan(actor, "user.manage");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (!reason) throw new ValidationError("A reason is required.");
  const last = parseLastDay(input.lastDay, now);
  const before = await getUserOrThrow(tx, id);
  assertCanTouchRole(actor, before.role);
  if (before.id === actor.userId) throw new ValidationError("You cannot deactivate your own account.");
  return { reason, last, before };
}

/**
 * The checklist shown before someone is turned off, with no writes, built from the same queries deactivateUser uses:
 * their sign-ups on details after the last day that have not started (these will be removed), worked details not yet billed (staff bill them or write them off), and invoices vendors
 * still owe them (these stay open).
 */
export async function departureChecklist(actor: Actor, tx: Tx, id: string, lastDay: string, now: Date = new Date()): Promise<DepartureChecklist> {
  assertCan(actor, "user.manage");
  const last = parseLastDay(lastDay, now);
  const user = await getUserOrThrow(tx, id);
  assertCanTouchRole(actor, user.role);
  return { upcoming: await signupsAfter(tx, id, last.after, now), unbilled: await unbilledWork(tx, id, now), unpaid: await unpaidInvoices(tx, id) };
}

/**
 * Someone leaves the agency: the account is turned off with a reason and a last day (today or earlier). The row and
 * all history stay. Their sign-ups on details after the last day that have not started yet are removed one by one through the usual removal
 * path, so a backup is offered the spot or it reopens; nobody is told why, and the person gets no alert. Unbilled
 * work and unpaid invoices are left as they are and returned for staff to follow up. Calendar feeds, API keys and
 * sign-in sessions end and stay ended.
 */
export async function deactivateUser(actor: Actor, tx: Tx, id: string, input: DeactivateInput, now: Date = new Date()): Promise<DeactivationResult> {
  const { reason, last, before } = await checkDeparture(actor, tx, id, input, now);
  if (!before.active) return { user: before, removed: [], unbilled: await unbilledWork(tx, id, now), unpaid: await unpaidInvoices(tx, id) };
  if (before.role === "admin") await assertAnotherAdmin(tx, id);

  const [after] = await tx
    .update(users)
    .set({ active: false, deactivatedAt: now, deactivatedBy: actor.userId, deactivationReason: reason, lastDay: last.key })
    .where(eq(users.id, id))
    .returning();
  await recordAudit(tx, { actor, action: "user.deactivate", entityType: "user", entityId: id, before, after, reason });
  await revokeCalendarTokensFor(tx, actor, id, now);
  const keys = await tx.update(apiKeys).set({ revokedAt: now }).where(and(eq(apiKeys.createdBy, id), isNull(apiKeys.revokedAt))).returning({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix });
  // Sequential: audit writes in this transaction.
  for (const k of keys) await recordAudit(tx, { actor, action: "api_key.revoke", entityType: "api_key", entityId: k.id, after: { name: k.name, prefix: k.prefix, revokedAt: now }, reason: "Account deactivated" });
  await tx.update(sessions).set({ expiresAt: now }).where(and(eq(sessions.userId, id), gt(sessions.expiresAt, now)));

  await lockUser(tx, id);
  const removed = await signupsAfter(tx, id, last.after, now);
  // Sequential: each sign-up is ended in this transaction, in order.
  for (const a of removed) {
    await leaveAssignment(actor, tx, a.assignmentId, {
      status: "removed",
      auditAction: DEPARTURE_REMOVE_ACTION,
      reason: `${LEFT_THE_AGENCY}: ${reason}`,
      removalReason: LEFT_THE_AGENCY,
      now,
    });
  }
  return { user: after, removed, unbilled: await unbilledWork(tx, id, now), unpaid: await unpaidInvoices(tx, id) };
}

/**
 * Turns a departed account back on, with a reason. Old sign-ups are not restored, and calendar feeds and API keys
 * stay revoked: the person makes new ones. They sign in with their password, or the normal reset.
 */
export async function reactivateUser(actor: Actor, tx: Tx, id: string, reason: string): Promise<User> {
  assertCan(actor, "user.manage");
  const why = typeof reason === "string" ? reason.trim() : "";
  if (!why) throw new ValidationError("A reason is required.");
  const before = await getUserOrThrow(tx, id);
  assertCanTouchRole(actor, before.role);
  if (before.active) throw new ValidationError("This account is already active.");
  const [after] = await tx
    .update(users)
    .set({ active: true, deactivatedAt: null, deactivatedBy: null, deactivationReason: null, lastDay: null })
    .where(eq(users.id, id))
    .returning();
  await recordAudit(tx, { actor, action: "user.reactivate", entityType: "user", entityId: id, before, after, reason: why });
  return after;
}
