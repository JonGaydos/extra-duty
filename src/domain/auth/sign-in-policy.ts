import { and, asc, count, eq, isNotNull, isNull, like, lte, min, sql } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { accounts, authThrottle, users, vendorUsers, verifications } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { getSettings } from "../settings/settings";
import { isInactive } from "./inactivity";

/** All sign-in limits use a sliding 15-minute window. */
export const THROTTLE_WINDOW_MS = 15 * 60_000;

/**
 * Attempts allowed per key inside the window; the next one is refused with 429.
 * `password_ip`: password checks for one email from one IP (the sixth is refused).
 * `password`: password checks for one email from every IP together, against guessing spread over many addresses.
 * People who share an IP (an office) never count against each other. A success clears both.
 * `code_send`: emailed codes per user. `code_verify`: code checks per user, across codes and sign-ins.
 */
const THROTTLE_LIMITS = { password_ip: 5, password: 10, code_send: 5, code_verify: 10 } as const;
export type ThrottleKind = keyof typeof THROTTLE_LIMITS;
export type ThrottleResult = { ok: true } | { ok: false; retryAfterMs: number };

export type SessionBlock = "ACCOUNT_DISABLED" | "ACCOUNT_LOCKED";

export const SESSION_BLOCK_MESSAGES: Record<SessionBlock, string> = {
  ACCOUNT_DISABLED: "This account is deactivated. Contact a coordinator.",
  ACCOUNT_LOCKED: "This account is locked. Reset your password to unlock it.",
};

export function normalizeEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return email ? email : null;
}

/**
 * Counts an attempt before it is made. Refuses it, recording nothing, when the key already has its limit of
 * attempts in the window, and says when the oldest of them leaves the window. A per-key advisory lock serializes
 * concurrent callers, so parallel requests cannot all pass.
 */
export async function takeAttempt(db: Db, kind: ThrottleKind, key: string, now = new Date()): Promise<ThrottleResult> {
  const cutoff = new Date(now.getTime() - THROTTLE_WINDOW_MS);
  return db.transaction(async (tx) => {
    const lockKey = `${kind}:${key}`;
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
    const where = and(eq(authThrottle.kind, kind), eq(authThrottle.key, key));
    await tx.delete(authThrottle).where(and(where, lte(authThrottle.at, cutoff)));
    const [row] = await tx.select({ n: count(), oldest: min(authThrottle.at) }).from(authThrottle).where(where);
    if (row.n >= THROTTLE_LIMITS[kind]) {
      const oldest = row.oldest ? new Date(row.oldest).getTime() : now.getTime();
      return { ok: false, retryAfterMs: oldest + THROTTLE_WINDOW_MS - now.getTime() };
    }
    await tx.insert(authThrottle).values({ kind, key, at: now });
    return { ok: true };
  });
}

/** The longest email address there can be (RFC 5321); a longer one is refused before it is counted. */
export const MAX_EMAIL_LENGTH = 320;

/** Drops every counted attempt older than the window, whatever its key (the daily tick); per-key pruning misses keys never tried again. */
export async function pruneThrottle(db: Db, now = new Date()): Promise<void> {
  await db.delete(authThrottle).where(lte(authThrottle.at, new Date(now.getTime() - THROTTLE_WINDOW_MS)));
}

/** Takes back one counted attempt (`at` as recorded): another limit refused it, so it was never made. */
export async function forgetAttempt(db: Db, kind: ThrottleKind, key: string, at: Date): Promise<void> {
  await db.delete(authThrottle).where(and(eq(authThrottle.kind, kind), eq(authThrottle.key, key), eq(authThrottle.at, at)));
}

/** Forgets counted attempts after a success. */
export async function clearAttempts(db: Db, kind: ThrottleKind, key: string): Promise<void> {
  await db.delete(authThrottle).where(and(eq(authThrottle.kind, kind), eq(authThrottle.key, key)));
}

async function passwordSetAt(tx: Tx, userId: string): Promise<Date | null> {
  const [acct] = await tx
    .select({ updatedAt: accounts.updatedAt })
    .from(accounts)
    .where(and(eq(accounts.userId, userId), eq(accounts.providerId, "credential")));
  return acct?.updatedAt ?? null;
}

/**
 * Runs before any session is created (after the password, and again after the
 * code). Deactivated accounts are refused. An account inactive past
 * `inactivityLockDays` is locked here (audited as system) and refused.
 */
export async function checkSessionAllowed(db: Db, userId: string, now = new Date()): Promise<SessionBlock | null> {
  return db.transaction(async (tx) => {
    const [u] = await tx.select().from(users).where(eq(users.id, userId));
    if (!u?.active) return "ACCOUNT_DISABLED";
    if (u.lockedAt) return "ACCOUNT_LOCKED";
    const { inactivityLockDays } = await getSettings(tx);
    const dates = { lastSignInAt: u.lastSignInAt, createdAt: u.createdAt, passwordSetAt: await passwordSetAt(tx, userId) };
    if (!isInactive(dates, inactivityLockDays, now)) return null;
    // Conditional update instead of a row lock: Better Auth may hold its own
    // connection on this row, and only the request that sets the lock audits it.
    const locked = await tx
      .update(users)
      .set({ lockedAt: now, lockReason: "inactivity" })
      .where(and(eq(users.id, userId), isNull(users.lockedAt)))
      .returning({ id: users.id });
    if (locked.length) {
      await recordAudit(tx, {
        actor: "system",
        action: "user.lock",
        entityType: "user",
        entityId: userId,
        before: { lockedAt: null, lockReason: null },
        after: { lockedAt: now, lockReason: "inactivity" },
      });
    }
    return "ACCOUNT_LOCKED";
  });
}

/** Actor for an active, unlocked user; null otherwise. */
export async function loadActiveActor(tx: Tx, userId: string): Promise<Actor | null> {
  const [u] = await tx
    .select({ id: users.id, role: users.role, rankId: users.rankId, active: users.active, lockedAt: users.lockedAt })
    .from(users)
    .where(eq(users.id, userId));
  if (!u || !u.active || u.lockedAt) return null;
  let vendorId: string | null = null;
  if (u.role === "vendor") {
    const [vu] = await tx
      .select({ vendorId: vendorUsers.vendorId })
      .from(vendorUsers)
      .where(eq(vendorUsers.userId, userId))
      .orderBy(asc(vendorUsers.createdAt))
      .limit(1);
    vendorId = vu?.vendorId ?? null;
  }
  return { userId: u.id, role: u.role, rankId: u.rankId, vendorId };
}

/** Called once a sign-in has produced a real session (code accepted, or a trusted device). */
export async function recordSignIn(db: Db, userId: string, now = new Date()): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx.select({ lastSignInAt: users.lastSignInAt }).from(users).where(eq(users.id, userId));
    await tx.update(users).set({ lastSignInAt: now }).where(eq(users.id, userId));
    const actor = await loadActiveActor(tx, userId);
    await recordAudit(tx, {
      actor: actor ?? "system",
      action: "auth.sign_in",
      entityType: "user",
      entityId: userId,
      before: { lastSignInAt: u?.lastSignInAt ?? null },
      after: { lastSignInAt: now },
    });
  });
}

/**
 * After a completed password reset: clears an inactivity or forced lock and
 * forgets trusted devices, so the next sign-in needs the emailed code.
 */
export async function completePasswordReset(db: Db, userId: string): Promise<void> {
  await db.transaction(async (tx) => {
    const [u] = await tx
      .select({ lockedAt: users.lockedAt, lockReason: users.lockReason })
      .from(users)
      .where(eq(users.id, userId));
    if (!u) return;
    await tx
      .delete(verifications)
      .where(and(eq(verifications.value, userId), like(verifications.identifier, "trust-device-%")));
    await recordAudit(tx, { actor: "system", action: "user.password_reset", entityType: "user", entityId: userId });
    if (!u.lockedAt) return;
    const unlocked = await tx
      .update(users)
      .set({ lockedAt: null, lockReason: null })
      .where(and(eq(users.id, userId), isNotNull(users.lockedAt)))
      .returning({ id: users.id });
    if (unlocked.length) {
      await recordAudit(tx, {
        actor: "system",
        action: "user.unlock",
        entityType: "user",
        entityId: userId,
        before: { lockedAt: u.lockedAt, lockReason: u.lockReason },
        after: { lockedAt: null, lockReason: null },
        reason: "Self-service password reset",
      });
    }
  });
}

/**
 * Two-factor is required for every account. Turns it back on for an account
 * that somehow has it off, before the password check reads the user.
 */
export async function ensureTwoFactorOn(db: Db, email: string): Promise<void> {
  await db
    .update(users)
    .set({ twoFactorEnabled: true })
    .where(and(eq(users.email, email), eq(users.twoFactorEnabled, false)));
}
