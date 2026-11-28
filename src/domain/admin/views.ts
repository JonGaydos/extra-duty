import { and, asc, count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { accessReviewItems, accessReviews, invites, qualificationRequests, qualifications, ranks, userQualifications, users } from "@/db/schema";
import type { Actor, Role } from "../actor";
import { assertCan } from "../auth/policy";
import { NotFoundError } from "../errors";
import { isSuspended } from "../users/suspension";
import { unbilledWork, unpaidInvoices, type DepartureInvoice, type DepartureUnbilled } from "../users/departure";

/** Read models for the Management screens. Each checks the person first; writes go through the domain services. */

export type UserListRow = {
  id: string;
  name: string;
  email: string;
  role: Role;
  rankName: string | null;
  active: boolean;
  suspended: boolean;
  lockedAt: Date | null;
};

export async function userDirectory(actor: Actor, tx: Tx, now: Date = new Date()): Promise<UserListRow[]> {
  assertCan(actor, "user.manage");
  const rows = await tx
    .select({ u: users, rankName: ranks.name })
    .from(users)
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .where(ne(users.role, "vendor"))
    .orderBy(asc(users.name));
  return rows.map(({ u, rankName }) => ({
    id: u.id,
    name: u.name,
    email: u.email,
    role: u.role,
    rankName,
    active: u.active,
    suspended: isSuspended(u, now),
    lockedAt: u.lockedAt,
  }));
}

type HeldFlag = { qualificationId: string; name: string; grantedAt: Date };

export type UserRecord = {
  user: typeof users.$inferSelect;
  rankName: string | null;
  suspended: boolean;
  flags: HeldFlag[];
  /** The newest invite: whether the person has set a password from it yet. */
  invite: { sentAt: Date; expiresAt: Date; usedAt: Date | null } | null;
  /** False when a coordinator looks at an admin account: only admins may change it. */
  canChange: boolean;
  /** Someone who left: when, by whom, why and their last day; null while the account is on. */
  departure: { at: Date; byName: string | null; reason: string | null; lastDay: string | null } | null;
  /** Someone who left: work not billed yet and invoices vendors still owe them. Empty while the account is on. */
  unbilled: DepartureUnbilled[];
  unpaid: DepartureInvoice[];
};

const departureOf = (u: typeof users.$inferSelect, byName: string | null): UserRecord["departure"] =>
  !u.active && u.deactivatedAt ? { at: u.deactivatedAt, byName, reason: u.deactivationReason, lastDay: u.lastDay } : null;

export async function userRecord(actor: Actor, tx: Tx, id: string, now: Date = new Date()): Promise<UserRecord> {
  assertCan(actor, "user.manage");
  const [row] = await tx.select({ u: users, rankName: ranks.name }).from(users).leftJoin(ranks, eq(ranks.id, users.rankId)).where(eq(users.id, id));
  if (!row) throw new NotFoundError("User not found.");
  const flags = await tx
    .select({ qualificationId: userQualifications.qualificationId, name: qualifications.name, grantedAt: userQualifications.grantedAt })
    .from(userQualifications)
    .innerJoin(qualifications, eq(qualifications.id, userQualifications.qualificationId))
    .where(and(eq(userQualifications.userId, id), isNull(userQualifications.revokedAt)))
    .orderBy(asc(qualifications.name));
  const [invite] = await tx
    .select({ sentAt: invites.createdAt, expiresAt: invites.expiresAt, usedAt: invites.usedAt })
    .from(invites)
    .where(eq(invites.userId, id))
    .orderBy(desc(invites.createdAt))
    .limit(1);
  const [by] = row.u.deactivatedBy ? await tx.select({ name: users.name }).from(users).where(eq(users.id, row.u.deactivatedBy)) : [];
  return {
    user: row.u,
    rankName: row.rankName,
    suspended: isSuspended(row.u, now),
    flags,
    invite: invite ?? null,
    canChange: row.u.role !== "admin" || actor.role === "admin",
    departure: departureOf(row.u, by?.name ?? null),
    unbilled: row.u.active ? [] : await unbilledWork(tx, id, now),
    unpaid: row.u.active ? [] : await unpaidInvoices(tx, id),
  };
}

export type FlagRow = { id: string; name: string; active: boolean; holders: number };
export type FlagRequestRow = { id: string; userId: string; userName: string; flagName: string; note: string | null; createdAt: Date; canDecide: boolean };

/** Every special flag with how many active people hold it, and the requests waiting for a decision. */
export async function flagOverview(actor: Actor, tx: Tx): Promise<{ flags: FlagRow[]; requests: FlagRequestRow[] }> {
  assertCan(actor, "qualification.manage");
  const held = tx
    .select({ qualificationId: userQualifications.qualificationId, n: count().as("n") })
    .from(userQualifications)
    .innerJoin(users, eq(users.id, userQualifications.userId))
    .where(and(isNull(userQualifications.revokedAt), eq(users.active, true)))
    .groupBy(userQualifications.qualificationId)
    .as("held");
  const flags = await tx
    .select({ id: qualifications.id, name: qualifications.name, active: qualifications.active, holders: sql<number>`coalesce(${held.n}, 0)::int` })
    .from(qualifications)
    .leftJoin(held, eq(held.qualificationId, qualifications.id))
    .orderBy(asc(qualifications.name));
  const requests = await tx
    .select({
      id: qualificationRequests.id,
      userId: qualificationRequests.userId,
      userName: users.name,
      userRole: users.role,
      flagName: qualifications.name,
      note: qualificationRequests.note,
      createdAt: qualificationRequests.createdAt,
    })
    .from(qualificationRequests)
    .innerJoin(users, eq(users.id, qualificationRequests.userId))
    .innerJoin(qualifications, eq(qualifications.id, qualificationRequests.qualificationId))
    .where(eq(qualificationRequests.status, "pending"))
    .orderBy(asc(qualificationRequests.createdAt));
  return { flags, requests: requests.map(({ userRole, ...r }) => ({ ...r, canDecide: userRole !== "admin" || actor.role === "admin" })) };
}

export type FlagRecord = {
  flag: { id: string; name: string; active: boolean };
  holders: Array<{ userId: string; name: string; rankName: string | null; grantedAt: Date; canChange: boolean }>;
  /** Active people (not vendors) who do not hold it, for the grant list. */
  candidates: Array<{ id: string; name: string }>;
};

export async function flagRecord(actor: Actor, tx: Tx, id: string): Promise<FlagRecord> {
  assertCan(actor, "qualification.manage");
  const [flag] = await tx.select({ id: qualifications.id, name: qualifications.name, active: qualifications.active }).from(qualifications).where(eq(qualifications.id, id));
  if (!flag) throw new NotFoundError("Flag not found.");
  const holders = await tx
    .select({ userId: users.id, name: users.name, role: users.role, rankName: ranks.name, grantedAt: userQualifications.grantedAt })
    .from(userQualifications)
    .innerJoin(users, eq(users.id, userQualifications.userId))
    .leftJoin(ranks, eq(ranks.id, users.rankId))
    .where(and(eq(userQualifications.qualificationId, id), isNull(userQualifications.revokedAt), eq(users.active, true)))
    .orderBy(asc(users.name));
  const holding = new Set(holders.map((h) => h.userId));
  const people = await tx
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.active, true), ne(users.role, "vendor")))
    .orderBy(asc(users.name));
  // Coordinators cannot change admin accounts, flags included.
  const mayChange = (role: Role) => role !== "admin" || actor.role === "admin";
  return {
    flag,
    holders: holders.map(({ role, ...h }) => ({ ...h, canChange: mayChange(role) })),
    candidates: people.filter((p) => !holding.has(p.id) && mayChange(p.role)).map(({ id, name }) => ({ id, name })),
  };
}

type ReviewSummary = {
  id: string;
  startedAt: Date;
  dueAt: Date;
  completedAt: Date | null;
  decided: number;
  total: number;
};

export type AccessReviewOverview = {
  open: (ReviewSummary & { pending: Array<{ itemId: string; userId: string; name: string; email: string; role: Role; lastSignInAt: Date | null }> }) | null;
  past: ReviewSummary[];
};

/** The open review with the people still to decide, and every earlier review with its counts. */
export async function accessReviewOverview(actor: Actor, tx: Tx): Promise<AccessReviewOverview> {
  assertCan(actor, "user.manage");
  const reviews = await tx
    .select({
      id: accessReviews.id,
      startedAt: accessReviews.startedAt,
      dueAt: accessReviews.dueAt,
      completedAt: accessReviews.completedAt,
      decided: sql<number>`count(${accessReviewItems.decision})::int`,
      total: sql<number>`count(${accessReviewItems.id})::int`,
    })
    .from(accessReviews)
    .leftJoin(accessReviewItems, eq(accessReviewItems.reviewId, accessReviews.id))
    .groupBy(accessReviews.id)
    .orderBy(desc(accessReviews.startedAt));
  const openReview = reviews.find((r) => !r.completedAt) ?? null;
  let open: AccessReviewOverview["open"] = null;
  if (openReview) {
    const pending = await tx
      .select({ itemId: accessReviewItems.id, userId: users.id, name: users.name, email: users.email, role: users.role, lastSignInAt: users.lastSignInAt })
      .from(accessReviewItems)
      .innerJoin(users, eq(users.id, accessReviewItems.userId))
      .where(and(eq(accessReviewItems.reviewId, openReview.id), isNull(accessReviewItems.decision)))
      .orderBy(asc(users.name));
    open = { ...openReview, pending };
  }
  return { open, past: reviews.filter((r) => r.completedAt) };
}

/** Active staff who may review ops plans (coordinators, admins and personnel). */
export async function reviewerOptions(actor: Actor, tx: Tx): Promise<Array<{ id: string; name: string; role: Role }>> {
  assertCan(actor, "settings.read");
  return tx
    .select({ id: users.id, name: users.name, role: users.role })
    .from(users)
    .where(and(eq(users.active, true), ne(users.role, "vendor")))
    .orderBy(asc(users.name));
}
