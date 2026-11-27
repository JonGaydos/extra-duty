import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, hiddenVendors, users, vendorUsers } from "@/db/schema";
import { vendorManagerIds } from "../vendors/managers";

/** People holding a spot or a place in line for the job: pending short, signed up or backup, once each. */
export async function jobAudience(tx: Tx, job: { id: string }): Promise<string[]> {
  const rows = await tx
    .selectDistinct({ userId: assignments.userId })
    .from(assignments)
    .where(and(eq(assignments.jobId, job.id), inArray(assignments.status, ["pending_short", "signed_up", "backup"])))
    .orderBy(asc(assignments.userId));
  return rows.map((r) => r.userId);
}

/** Active coordinators and admins. */
export async function coordinatorAudience(tx: Tx): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.active, true), inArray(users.role, ["coordinator", "admin"])))
    .orderBy(asc(users.id));
  return rows.map((r) => r.id);
}

/**
 * The coordinators and admins, plus the deputies who manage this vendor (owner decision 2026-11-27): alerts about a
 * vendor's details that go to the coordinators also go to its managers.
 */
export async function vendorStaffAudience(tx: Tx, vendorId: string): Promise<string[]> {
  return [...new Set([...(await coordinatorAudience(tx)), ...(await vendorManagerIds(tx, vendorId))])];
}

/** Active logins of one vendor. */
export async function vendorAudience(tx: Tx, vendorId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(vendorUsers)
    .innerJoin(users, eq(users.id, vendorUsers.userId))
    .where(and(eq(vendorUsers.vendorId, vendorId), eq(users.active, true)))
    .orderBy(asc(users.id));
  return rows.map((r) => r.id);
}

/**
 * Drops people who hid the vendor. Hidden vendors affect discovery only (lists, recommendations, watch and
 * release alerts); never use this for alerts about a person's own assignments.
 */
export async function withoutHiddenVendor(tx: Tx, userIds: string[], vendorId: string): Promise<string[]> {
  if (userIds.length === 0) return [];
  const rows = await tx
    .select({ userId: hiddenVendors.userId })
    .from(hiddenVendors)
    .where(and(eq(hiddenVendors.vendorId, vendorId), inArray(hiddenVendors.userId, userIds)));
  const hidden = new Set(rows.map((r) => r.userId));
  return userIds.filter((u) => !hidden.has(u));
}
