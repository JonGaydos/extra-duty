import { and, asc, eq, gt, inArray, isNotNull, isNull, lte } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accounts, assignments, jobs, users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { emit } from "../notifications/notify";
import { ValidationError } from "../errors";
import { isInactive } from "../auth/inactivity";
import { getSettings } from "../settings/settings";
import { leaveAssignment } from "../assignments/backups";
import { SUSPENSION_REMOVAL_REASON, SUSPENSION_REMOVE_ACTION } from "../assignments/history";
import { lockUser } from "../assignments/signup";
import { assertCanTouchRole, getUserOrThrow, type User } from "./users";

export type SuspensionInput = { reason: string; until: Date | null; removeFutureAssignments: boolean };

/** A suspension has a reason; `until` null means until lifted. */
export function isSuspended(user: Pick<User, "suspendedUntil" | "suspensionReason">, now: Date): boolean {
  if (user.suspensionReason === null) return false;
  return user.suspendedUntil === null || user.suspendedUntil.getTime() > now.getTime();
}

export async function suspendUser(actor: Actor, tx: Tx, id: string, input: SuspensionInput): Promise<User> {
  assertCan(actor, "user.suspend");
  const reason = input.reason.trim();
  if (!reason) throw new ValidationError("A reason is required.");
  const now = new Date();
  if (input.until && input.until.getTime() <= now.getTime()) throw new ValidationError("The end date must be in the future.");
  const before = await getUserOrThrow(tx, id);
  assertCanTouchRole(actor, before.role);

  const [after] = await tx
    .update(users)
    .set({ suspendedUntil: input.until, suspensionReason: reason })
    .where(eq(users.id, id))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "user.suspend",
    entityType: "user",
    entityId: id,
    before: { suspendedUntil: before.suspendedUntil, suspensionReason: before.suspensionReason },
    after: { suspendedUntil: after.suspendedUntil, suspensionReason: after.suspensionReason },
    reason,
  });
  await emit(tx, {
    recipients: [id],
    type: "user.suspended",
    mandatory: true,
    title: "Your account was suspended",
    body: `${reason}${input.until ? "" : " The suspension lasts until a coordinator lifts it."}`,
    link: "/profile",
  });

  if (input.removeFutureAssignments) {
    await lockUser(tx, id);
    const future = await tx
      .select({ id: assignments.id })
      .from(assignments)
      .innerJoin(jobs, eq(jobs.id, assignments.jobId))
      .where(and(eq(assignments.userId, id), inArray(assignments.status, ["signed_up", "backup", "pending_short"]), gt(jobs.startAt, now)))
      .orderBy(asc(assignments.jobId), asc(assignments.id));
    for (const a of future) {
      // Suspension is a personnel matter: the person's notice about each detail reads as a plain cancellation.
      await leaveAssignment(actor, tx, a.id, {
        status: "removed",
        auditAction: SUSPENSION_REMOVE_ACTION,
        reason: `${SUSPENSION_REMOVAL_REASON}: ${reason}`,
        removalReason: SUSPENSION_REMOVAL_REASON,
        notifyTitle: "Your sign-up was canceled",
        notifyBody: "Your sign-up for this detail was canceled.",
        now,
      });
    }
  }
  return after;
}

export async function liftSuspension(actor: Actor | "system", tx: Tx, id: string): Promise<User> {
  if (actor !== "system") assertCan(actor, "user.suspend");
  const before = await getUserOrThrow(tx, id);
  if (actor !== "system") assertCanTouchRole(actor, before.role);
  if (before.suspensionReason === null) return before;
  const [after] = await tx
    .update(users)
    .set({ suspendedUntil: null, suspensionReason: null })
    .where(eq(users.id, id))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "user.suspension_lift",
    entityType: "user",
    entityId: id,
    before: { suspendedUntil: before.suspendedUntil, suspensionReason: before.suspensionReason },
    after: { suspendedUntil: null, suspensionReason: null },
  });
  return after;
}

/** Worker job: clears suspensions whose end has passed. Returns how many were lifted. */
export async function liftExpiredSuspensions(tx: Tx, now: Date): Promise<number> {
  const due = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(isNotNull(users.suspensionReason), isNotNull(users.suspendedUntil), lte(users.suspendedUntil, now)));
  for (const u of due) await liftSuspension("system", tx, u.id);
  return due.length;
}

/**
 * Worker job: locks active accounts that have been inactive past
 * `inactivityLockDays`, using the same rule as sign-in (`isInactive`).
 */
export async function inactivityLockTick(tx: Tx, now: Date): Promise<number> {
  const { inactivityLockDays } = await getSettings(tx);
  const rows = await tx
    .select({ user: users, passwordSetAt: accounts.updatedAt })
    .from(users)
    .leftJoin(accounts, and(eq(accounts.userId, users.id), eq(accounts.providerId, "credential")))
    .where(and(eq(users.active, true), isNull(users.lockedAt)));
  let locked = 0;
  for (const { user, passwordSetAt } of rows) {
    const dates = { lastSignInAt: user.lastSignInAt, createdAt: user.createdAt, passwordSetAt };
    if (!isInactive(dates, inactivityLockDays, now)) continue;
    await tx.update(users).set({ lockedAt: now, lockReason: "inactivity" }).where(eq(users.id, user.id));
    await recordAudit(tx, {
      actor: "system",
      action: "user.lock",
      entityType: "user",
      entityId: user.id,
      before: { lockedAt: null, lockReason: null },
      after: { lockedAt: now, lockReason: "inactivity" },
    });
    locked++;
  }
  return locked;
}
