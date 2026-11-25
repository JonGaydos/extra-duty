import { asc, count, eq, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { ranks, users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { NotFoundError, RuleViolation, ValidationError } from "../errors";
import { assertCan } from "../auth/policy";

export type Rank = typeof ranks.$inferSelect;

/** Ladder ranks at or above rankId, lowest first. An out-of-ladder rank returns only itself. */
export function ranksAtOrAbove(rankId: string, all: Rank[]): string[] {
  const ladder = all.filter((r) => r.inLadder && r.active).sort((a, b) => a.sortOrder - b.sortOrder);
  const idx = ladder.findIndex((r) => r.id === rankId);
  if (idx === -1) return [rankId];
  return ladder.slice(idx).map((r) => r.id);
}

export function isEligible(rankId: string, eligibleRankIds: string[]): boolean {
  return eligibleRankIds.includes(rankId);
}

export function listRanks(tx: Tx): Promise<Rank[]> {
  return tx.select().from(ranks).orderBy(asc(ranks.sortOrder));
}

export async function createRank(
  actor: Actor,
  tx: Tx,
  input: { name: string; sortOrder: number },
): Promise<Rank> {
  assertCan(actor, "rank.manage");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Rank name is required.");
  const [row] = await tx.insert(ranks).values({ name, sortOrder: input.sortOrder }).returning();
  await recordAudit(tx, {
    actor,
    action: "rank.create",
    entityType: "rank",
    entityId: row.id,
    before: null,
    after: row,
  });
  return row;
}

/** Sets sortOrder to 1..n in the given order. The list must name every rank exactly once. */
export async function reorderRanks(actor: Actor, tx: Tx, orderedIds: string[]): Promise<Rank[]> {
  assertCan(actor, "rank.manage");
  const before = await listRanks(tx);
  const known = new Set(before.map((r) => r.id));
  const given = new Set(orderedIds);
  if (given.size !== orderedIds.length || given.size !== known.size || orderedIds.some((id) => !known.has(id))) {
    throw new RuleViolation([
      { check: "rank.reorder.complete", ok: false, message: "The new order must list every rank exactly once." },
    ]);
  }
  // sort_order is unique: move everything out of range first, then to the final values.
  const offset = before.length + 1000;
  await tx.update(ranks).set({ sortOrder: sql`${ranks.sortOrder} + ${offset}` });
  for (const [i, id] of orderedIds.entries()) {
    await tx.update(ranks).set({ sortOrder: i + 1 }).where(eq(ranks.id, id));
  }
  const after = await listRanks(tx);
  await recordAudit(tx, {
    actor,
    action: "rank.reorder",
    entityType: "rank",
    entityId: "all",
    before: before.map((r) => ({ id: r.id, sortOrder: r.sortOrder })),
    after: after.map((r) => ({ id: r.id, sortOrder: r.sortOrder })),
  });
  return after;
}

export async function deactivateRank(actor: Actor, tx: Tx, id: string): Promise<Rank> {
  assertCan(actor, "rank.manage");
  const [before] = await tx.select().from(ranks).where(eq(ranks.id, id));
  if (!before) throw new NotFoundError("Rank not found.");
  const [held] = await tx.select({ n: count() }).from(users).where(eq(users.rankId, id));
  if (held.n > 0) {
    throw new RuleViolation([
      {
        check: "rank.deactivate.unused",
        ok: false,
        message: `${held.n} user(s) still hold this rank. Move them to another rank first.`,
      },
    ]);
  }
  const [after] = await tx
    .update(ranks)
    .set({ active: false, updatedAt: new Date() })
    .where(eq(ranks.id, id))
    .returning();
  await recordAudit(tx, { actor, action: "rank.deactivate", entityType: "rank", entityId: id, before, after });
  return after;
}
