import { and, asc, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobs, users, vendorLocations, vendorManagers, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan, isVendorManager } from "../auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { byText } from "@/lib/sort";

/**
 * Vendor managers (owner decision 2026-11-27): a deputy who handles a few chosen vendors' details for the agency, so a
 * coordinator does not have to. Staff choose the vendors on the person's page; the policy's manager-scoped actions
 * then allow the deputy for those vendors only.
 */

/** The vendor ids a person manages. */
export async function managedVendorIdsOf(tx: Tx, userId: string): Promise<string[]> {
  const rows = await tx.select({ vendorId: vendorManagers.vendorId }).from(vendorManagers).where(eq(vendorManagers.userId, userId));
  return rows.map((r) => r.vendorId).sort(byText);
}

/** The active deputies who manage a vendor: they get the coordinators' alerts about its details. */
export async function vendorManagerIds(tx: Tx, vendorId: string): Promise<string[]> {
  const rows = await tx
    .select({ id: users.id })
    .from(vendorManagers)
    .innerJoin(users, eq(users.id, vendorManagers.userId))
    .where(and(eq(vendorManagers.vendorId, vendorId), eq(users.active, true), eq(users.role, "personnel")))
    .orderBy(asc(users.id));
  return rows.map((r) => r.id);
}

/** The vendors the actor manages, by name. */
export async function managedVendors(actor: Actor, tx: Tx): Promise<Array<{ id: string; name: string; active: boolean }>> {
  const ids = actor.role === "personnel" ? [...(actor.managedVendorIds ?? [])] : [];
  if (ids.length === 0) return [];
  return tx.select({ id: vendors.id, name: vendors.name, active: vendors.active }).from(vendors).where(inArray(vendors.id, ids)).orderBy(asc(vendors.name));
}

/** Sets the vendors a deputy manages (staff who manage users). Only a deputy (personnel) can manage vendors. Audited. */
export async function setManagedVendors(actor: Actor, tx: Tx, userId: string, vendorIds: string[]): Promise<string[]> {
  assertCan(actor, "user.manage");
  const [u] = await tx.select({ role: users.role }).from(users).where(eq(users.id, userId));
  if (!u) throw new NotFoundError("User not found.");
  if (!Array.isArray(vendorIds) || vendorIds.some((id) => typeof id !== "string")) throw new ValidationError("A vendor was not found.");
  const wanted = [...new Set(vendorIds)].sort(byText);
  if (u.role !== "personnel" && wanted.length > 0) throw new ValidationError("Only a deputy can manage vendors. Coordinators and admins manage every vendor already.");
  const found = wanted.length ? await tx.select({ id: vendors.id }).from(vendors).where(inArray(vendors.id, wanted)) : [];
  if (found.length !== wanted.length) throw new ValidationError("A vendor was not found.");
  const before = await managedVendorIdsOf(tx, userId);
  if (before.length === wanted.length && before.every((id, i) => id === wanted[i])) return before;
  const gone = before.filter((id) => !wanted.includes(id));
  const added = wanted.filter((id) => !before.includes(id));
  if (gone.length) await tx.delete(vendorManagers).where(and(eq(vendorManagers.userId, userId), inArray(vendorManagers.vendorId, gone)));
  if (added.length) await tx.insert(vendorManagers).values(added.map((vendorId) => ({ userId, vendorId, createdBy: actor.userId })));
  await recordAudit(tx, { actor, action: "user.managed_vendors", entityType: "user", entityId: userId, before: { vendorIds: before }, after: { vendorIds: wanted } });
  return wanted;
}

export type ManagedDetailRow = {
  id: string;
  number: number;
  title: string;
  startAt: Date;
  endAt: Date;
  state: string;
  held: boolean;
  locationName: string | null;
  /** Spots across every position, and how many are held by someone. */
  needed: number;
  filled: number;
  /** Changes the vendor asked for, waiting for a decision. */
  pendingChanges: number;
};

export type ManagerOverview = {
  vendors: Array<{ id: string; name: string; active: boolean; requests: ManagedDetailRow[]; upcoming: ManagedDetailRow[] }>;
};

const UPCOMING_DAYS = 120;

/**
 * The Manage tab: each vendor the deputy manages, its requests waiting for a decision and its details over the next
 * 120 days (including held and unreleased ones). Vendor managers only; coordinators use To-do and Details.
 */
export async function managerOverview(actor: Actor, tx: Tx, now: Date = new Date()): Promise<ManagerOverview> {
  if (!isVendorManager(actor)) throw new ForbiddenError();
  const list = await managedVendors(actor, tx);
  const ids = list.map((v) => v.id);
  const until = new Date(now.getTime() + UPCOMING_DAYS * 86_400_000);
  const rows = ids.length
    ? await tx
        .select({
          id: jobs.id,
          vendorId: jobs.vendorId,
          number: jobs.number,
          title: jobs.title,
          startAt: jobs.startAt,
          endAt: jobs.endAt,
          state: jobs.state,
          held: jobs.held,
          locationName: vendorLocations.name,
          needed: sql<number>`(select coalesce(sum(p.count), 0)::int from job_positions p where p.job_id = ${jobs.id})`,
          filled: sql<number>`(select count(*)::int from assignments a where a.job_id = ${jobs.id} and a.status in ('signed_up', 'pending_short'))`,
          pendingChanges: sql<number>`(select count(*)::int from job_change_requests c where c.job_id = ${jobs.id} and c.status = 'pending')`,
        })
        .from(jobs)
        .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
        // Never a confidential detail: managers see one only when assigned, and then as a deputy (owner decision 2026-11-27).
        .where(and(inArray(jobs.vendorId, ids), eq(jobs.confidential, false), gt(jobs.endAt, now), lte(jobs.startAt, until), inArray(jobs.state, ["requested", "scheduled", "active"])))
        .orderBy(asc(jobs.startAt), asc(jobs.number))
    : [];
  return {
    vendors: list.map((v) => {
      const own: ManagedDetailRow[] = rows.filter((r) => r.vendorId === v.id);
      return { ...v, requests: own.filter((r) => r.state === "requested"), upcoming: own.filter((r) => r.state !== "requested") };
    }),
  };
}
