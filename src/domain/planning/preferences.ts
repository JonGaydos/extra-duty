import { and, asc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { earningsGoals, hiddenVendors, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { NotFoundError, ValidationError } from "../errors";
import type { Cents } from "../types";
import { assertOwn } from "./schedule";

/** Audit rows for planning data name the action and the user only; amounts and vendors stay private. */
const audit = (tx: Tx, actor: Actor, action: string) => recordAudit(tx, { actor, action, entityType: "planning", entityId: actor.userId });

const MAX_GOAL_CENTS = 100_000_000;

/** A monthly goal in whole cents; null clears it. */
export async function setEarningsGoal(actor: Actor, tx: Tx, monthlyCents: Cents | null): Promise<void> {
  assertOwn(actor);
  if (monthlyCents !== null && (!Number.isInteger(monthlyCents) || monthlyCents <= 0 || monthlyCents > MAX_GOAL_CENTS)) {
    throw new ValidationError("The goal must be a whole number of cents greater than zero.");
  }
  await tx
    .insert(earningsGoals)
    .values({ userId: actor.userId, monthlyCents })
    .onConflictDoUpdate({ target: earningsGoals.userId, set: { monthlyCents, updatedAt: new Date() } });
  await audit(tx, actor, "planning.earnings_goal_set");
}

export async function getEarningsGoal(actor: Actor, tx: Tx, userId: string): Promise<Cents | null> {
  assertOwn(actor, userId);
  const [row] = await tx.select({ monthlyCents: earningsGoals.monthlyCents }).from(earningsGoals).where(eq(earningsGoals.userId, userId));
  return row?.monthlyCents ?? null;
}

export async function hideVendor(actor: Actor, tx: Tx, vendorId: string): Promise<void> {
  assertOwn(actor);
  const [vendor] = await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId));
  if (!vendor) throw new NotFoundError("Vendor not found.");
  await tx.insert(hiddenVendors).values({ userId: actor.userId, vendorId }).onConflictDoNothing();
  await audit(tx, actor, "planning.vendor_hide");
}

/** A private list preference, so the row is removed outright. */
export async function unhideVendor(actor: Actor, tx: Tx, vendorId: string): Promise<void> {
  assertOwn(actor);
  await tx.delete(hiddenVendors).where(and(eq(hiddenVendors.userId, actor.userId), eq(hiddenVendors.vendorId, vendorId)));
  await audit(tx, actor, "planning.vendor_unhide");
}

export async function listHiddenVendors(actor: Actor, tx: Tx, userId: string): Promise<Array<{ vendorId: string; name: string }>> {
  assertOwn(actor, userId);
  return tx
    .select({ vendorId: hiddenVendors.vendorId, name: vendors.name })
    .from(hiddenVendors)
    .innerJoin(vendors, eq(vendors.id, hiddenVendors.vendorId))
    .where(eq(hiddenVendors.userId, userId))
    .orderBy(asc(vendors.name), asc(vendors.id));
}
