import { and, asc, count, eq, gt, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { auditLog, jobPositions, jobs, positionTypes, ranks, savedReports, settings, users } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { NotFoundError, RuleViolation, ValidationError } from "../errors";
import { assertCan } from "../auth/policy";

export type Rank = typeof ranks.$inferSelect;

/**
 * Ranks are stored lowest first (sort_order 1 is the lowest ladder rank); every screen shows them highest first.
 * A higher ladder rank can fill a lower rank's spot. A rank outside the ladder fills only its own spots.
 */

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

/** The ladder for display: highest first, numbered from 1 by position. Turned-off ladder ranks keep their place. */
export function ladderHighestFirst(all: Rank[]): Rank[] {
  return all.filter((r) => r.inLadder).sort((a, b) => b.sortOrder - a.sortOrder);
}

/** Ranks outside the ladder, in the order they were added. */
export function outsideLadder(all: Rank[]): Rank[] {
  return all.filter((r) => !r.inLadder).sort((a, b) => a.sortOrder - b.sortOrder);
}

const activeLadder = (all: Rank[]) => new Set(all.filter((r) => r.inLadder && r.active).map((r) => r.id));
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

/**
 * A position's rank list after the ladder changes from `before` to `after`, so "a higher rank can fill a lower
 * rank's spot" still holds:
 * - A list that follows the ladder (one rank and every ladder rank above it) follows the new ladder from the same
 *   rank; if that rank left the ladder, only it fills the spot.
 * - A rank alone in its list that joins the ladder gets the ranks above it.
 * - Any other list only loses a rank that left the ladder, unless that rank is all it has.
 * Ranks outside both ladders stay where they are.
 */
export function relinkRanks(list: string[], before: Rank[], after: Rank[]): string[] {
  const oldLadder = activeLadder(before);
  const newLadder = activeLadder(after);
  const order = new Map(before.map((r) => [r.id, r.sortOrder]));
  const inOld = list.filter((id) => oldLadder.has(id));
  if (inOld.length === 0) {
    if (list.length === 1 && newLadder.has(list[0])) return ranksAtOrAbove(list[0], after);
    return list;
  }
  const base = [...inOld].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))[0];
  const rest = list.filter((id) => !oldLadder.has(id));
  if (sameSet(inOld, ranksAtOrAbove(base, before))) {
    if (!newLadder.has(base)) return [...new Set([base, ...rest])];
    return [...new Set([...ranksAtOrAbove(base, after), ...rest.filter((id) => !newLadder.has(id))])];
  }
  const left = new Set(inOld.filter((id) => !newLadder.has(id)));
  const kept = list.filter((id) => !left.has(id));
  return kept.length ? kept : list;
}

export function listRanks(tx: Tx): Promise<Rank[]> {
  return tx.select().from(ranks).orderBy(asc(ranks.sortOrder));
}

async function getRank(tx: Tx, id: string): Promise<Rank> {
  const [row] = await tx.select().from(ranks).where(eq(ranks.id, id));
  if (!row) throw new NotFoundError("Rank not found.");
  return row;
}

async function assertRankNameFree(tx: Tx, name: string, exceptId?: string): Promise<void> {
  const rows = await tx.select({ id: ranks.id }).from(ranks).where(sql`lower(${ranks.name}) = lower(${name})`);
  if (rows.some((r) => r.id !== exceptId)) throw new ValidationError(`A rank named "${name}" already exists.`);
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (!n) throw new ValidationError("Rank name is required.");
  if (n.length > 60) throw new ValidationError("Keep the rank name to 60 characters.");
  return n;
}

export async function createRank(actor: Actor, tx: Tx, input: { name: string; sortOrder: number; inLadder?: boolean }): Promise<Rank> {
  assertCan(actor, "rank.manage");
  const name = cleanName(input.name);
  await assertRankNameFree(tx, name);
  const [row] = await tx.insert(ranks).values({ name, sortOrder: input.sortOrder, inLadder: input.inLadder ?? true }).returning();
  await recordAudit(tx, { actor, action: "rank.create", entityType: "rank", entityId: row.id, before: null, after: row });
  return row;
}

/** Renames a rank. People, positions and records keep it: they refer to it by id. */
export async function renameRank(actor: Actor, tx: Tx, id: string, name: string): Promise<Rank> {
  assertCan(actor, "rank.manage");
  const before = await getRank(tx, id);
  const next = cleanName(name);
  if (next === before.name) return before;
  await assertRankNameFree(tx, next, id);
  const [after] = await tx.update(ranks).set({ name: next, updatedAt: new Date() }).where(eq(ranks.id, id)).returning();
  await recordAudit(tx, { actor, action: "rank.rename", entityType: "rank", entityId: id, before, after });
  return after;
}

/** A change to the ladder. `place` counts from the top: 1 is the highest rank. */
export type RankChange =
  | { kind: "move"; id: string; direction: "higher" | "lower" }
  | { kind: "ladder"; id: string; inLadder: boolean; place?: number }
  | { kind: "create"; name: string; inLadder: boolean; place?: number };

/** The id a rank that is being added has in a preview. */
const NEW_RANK = "new-rank";

type Layout = { ladder: Rank[]; outside: Rank[] };

/** `r` inserted at `at` (1 is the top), or at the bottom. */
function placeAt(list: Rank[], r: Rank, at: number | undefined): Rank[] {
  const i = Math.min(Math.max(1, at ?? list.length + 1), list.length + 1) - 1;
  return [...list.slice(0, i), r, ...list.slice(i)];
}

function moved({ ladder, outside }: Layout, id: string, direction: "higher" | "lower"): Layout {
  const i = ladder.findIndex((r) => r.id === id);
  const j = direction === "higher" ? i - 1 : i + 1;
  if (i === -1 || j < 0 || j >= ladder.length) return { ladder, outside };
  const next = [...ladder];
  [next[i], next[j]] = [next[j], next[i]];
  return { ladder: next, outside };
}

function toggled({ ladder, outside }: Layout, r: Rank | undefined, inLadder: boolean, place?: number): Layout {
  if (!r || r.inLadder === inLadder) return { ladder, outside };
  if (inLadder) return { ladder: placeAt(ladder, { ...r, inLadder: true }, place), outside: outside.filter((x) => x.id !== r.id) };
  return { ladder: ladder.filter((x) => x.id !== r.id), outside: [...outside, { ...r, inLadder: false }] };
}

/** The ranks after a change, with sort_order rewritten: ladder ranks 1..n lowest first, then those outside it. */
export function arrangeRanks(all: Rank[], change: RankChange, newRank?: Rank): Rank[] {
  let layout: Layout = { ladder: ladderHighestFirst(all), outside: outsideLadder(all) };
  if (change.kind === "move") layout = moved(layout, change.id, change.direction);
  else if (change.kind === "ladder") layout = toggled(layout, all.find((x) => x.id === change.id), change.inLadder, change.place);
  else if (newRank) layout = toggled(layout, { ...newRank, inLadder: !change.inLadder }, change.inLadder, change.place);
  const lowFirst = [...layout.ladder].reverse();
  return [...lowFirst.map((r, i) => ({ ...r, sortOrder: i + 1 })), ...layout.outside.map((r, i) => ({ ...r, sortOrder: lowFirst.length + i + 1 }))];
}

export type PositionRankChange = { positionTypeId: string; name: string; added: string[]; removed: string[]; upcomingDetails: number; next: string[] };

/** Position types whose rank lists the change rewrites, with the names added and removed and the details it touches. */
async function positionChanges(tx: Tx, before: Rank[], after: Rank[], now: Date): Promise<PositionRankChange[]> {
  const names = new Map(after.map((r) => [r.id, r.name]));
  const out: PositionRankChange[] = [];
  const types = await tx.select().from(positionTypes).orderBy(asc(positionTypes.sortOrder), asc(positionTypes.name));
  for (const t of types) {
    const next = relinkRanks(t.eligibleRankIds, before, after);
    if (sameSet(next, t.eligibleRankIds)) continue;
    // Sequential: one count per changed position type, in this transaction.
    const [n] = await tx
      .select({ n: sql<number>`count(distinct ${jobs.id})::int` })
      .from(jobPositions)
      .innerJoin(jobs, eq(jobs.id, jobPositions.jobId))
      .where(and(eq(jobPositions.positionTypeId, t.id), isNull(jobPositions.eligibleRankIdsOverride), inArray(jobs.state, ["requested", "scheduled", "active"]), gt(jobs.endAt, now)));
    out.push({
      positionTypeId: t.id,
      name: t.name,
      added: next.filter((id) => !t.eligibleRankIds.includes(id)).map((id) => names.get(id) ?? id),
      removed: t.eligibleRankIds.filter((id) => !next.includes(id)).map((id) => names.get(id) ?? id),
      upcomingDetails: n?.n ?? 0,
      next,
    });
  }
  return out;
}

function placeholder(change: Extract<RankChange, { kind: "create" }>): Rank {
  const at = new Date();
  return { id: NEW_RANK, name: change.name.trim() || "New rank", sortOrder: 0, inLadder: change.inLadder, active: true, createdAt: at, updatedAt: at };
}

/** What a ladder change would do to who can fill each position type, before it is made. */
export async function previewRankChange(actor: Actor, tx: Tx, change: RankChange, now: Date = new Date()): Promise<PositionRankChange[]> {
  assertCan(actor, "rank.manage");
  const before = await listRanks(tx);
  const after = arrangeRanks(before, change, change.kind === "create" ? placeholder(change) : undefined);
  return positionChanges(tx, before, after, now);
}

/** Writes sort_order and in_ladder as arranged; sort_order is unique, so everything moves out of range first. */
async function writeLayout(tx: Tx, after: Rank[]): Promise<void> {
  const offset = after.length + 1000;
  await tx.update(ranks).set({ sortOrder: sql`${ranks.sortOrder} + ${offset}` });
  // Sequential: updates in this transaction; sort_order is unique.
  for (const r of after) await tx.update(ranks).set({ sortOrder: r.sortOrder, inLadder: r.inLadder, updatedAt: new Date() }).where(eq(ranks.id, r.id));
}

/** The audit reason on a position type rewritten by a ladder change. */
const LADDER_REASON = "Rank ladder changed";

const AUDIT_ACTION: Record<RankChange["kind"], string> = { move: "rank.reorder", ladder: "rank.ladder", create: "rank.create" };
const layoutOf = (all: Rank[]) => ladderHighestFirst(all).map((r, i) => ({ id: r.id, name: r.name, place: i + 1 })).concat(outsideLadder(all).map((r) => ({ id: r.id, name: r.name, place: 0 })));

/**
 * Makes a ladder change: moves a rank, takes it into or out of the ladder, or adds one. Position types that follow the
 * ladder are rewritten so a higher rank still fills a lower rank's spot (see relinkRanks); each rewrite is audited.
 */
export async function applyRankChange(actor: Actor, tx: Tx, change: RankChange, now: Date = new Date()): Promise<{ ranks: Rank[]; positions: PositionRankChange[]; rank: Rank | null }> {
  assertCan(actor, "rank.manage");
  let before = await listRanks(tx);
  let created: Rank | null = null;
  if (change.kind === "create") {
    created = await createRank(actor, tx, { name: change.name, sortOrder: Math.max(0, ...before.map((r) => r.sortOrder)) + before.length + 2000, inLadder: change.inLadder });
    // The new rank fills nothing yet: relinking starts from the ladder without it.
  } else {
    const r = await getRank(tx, change.id);
    if (change.kind === "move" && !r.inLadder) throw new ValidationError("Only ranks in the ladder move up or down.");
  }
  const after = arrangeRanks(before, change, created ?? undefined);
  if (created) before = [...before, { ...created, inLadder: false }];
  const positions = await positionChanges(tx, before, after, now);
  await writeLayout(tx, after);
  const id = change.kind === "create" ? created!.id : change.id;
  if (change.kind !== "create") await recordAudit(tx, { actor, action: AUDIT_ACTION[change.kind], entityType: "rank", entityId: id, before: layoutOf(before), after: layoutOf(after) });
  // Sequential: one update and audit entry per rewritten position type, in this transaction.
  for (const p of positions) {
    const [b] = await tx.select().from(positionTypes).where(eq(positionTypes.id, p.positionTypeId));
    const [a] = await tx.update(positionTypes).set({ eligibleRankIds: p.next, updatedAt: new Date() }).where(eq(positionTypes.id, p.positionTypeId)).returning();
    await recordAudit(tx, { actor, action: "position_type.update", entityType: "position_type", entityId: p.positionTypeId, before: b, after: a, reason: LADDER_REASON });
  }
  return { ranks: await listRanks(tx), positions, rank: created ? await getRank(tx, created.id) : null };
}

/** Sets sortOrder to 1..n in the given order. The list must name every rank exactly once. */
export async function reorderRanks(actor: Actor, tx: Tx, orderedIds: string[]): Promise<Rank[]> {
  assertCan(actor, "rank.manage");
  const before = await listRanks(tx);
  const known = new Set(before.map((r) => r.id));
  const given = new Set(orderedIds);
  if (given.size !== orderedIds.length || given.size !== known.size || orderedIds.some((id) => !known.has(id))) {
    throw new RuleViolation([{ check: "rank.reorder.complete", ok: false, message: "The new order must list every rank exactly once." }]);
  }
  const byId = new Map(before.map((r) => [r.id, r]));
  await writeLayout(
    tx,
    orderedIds.map((id, i) => ({ ...byId.get(id)!, sortOrder: i + 1 })),
  );
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

/** Turning a rank off or on; a rank someone holds stays on. */
export async function setRankActive(actor: Actor, tx: Tx, id: string, active: boolean): Promise<Rank> {
  assertCan(actor, "rank.manage");
  const before = await getRank(tx, id);
  if (before.active === active) return before;
  if (!active) {
    const [held] = await tx.select({ n: count() }).from(users).where(eq(users.rankId, id));
    if (held.n > 0) {
      throw new RuleViolation([{ check: "rank.deactivate.unused", ok: false, message: `${held.n} user(s) still hold this rank. Move them to another rank first.` }]);
    }
  }
  const [after] = await tx.update(ranks).set({ active, updatedAt: new Date() }).where(eq(ranks.id, id)).returning();
  await recordAudit(tx, { actor, action: active ? "rank.activate" : "rank.deactivate", entityType: "rank", entityId: id, before, after });
  return after;
}

export async function deactivateRank(actor: Actor, tx: Tx, id: string): Promise<Rank> {
  return setRankActive(actor, tx, id, false);
}

/** Where a rank is used. A rank with any use is kept forever (turned off at most); `reason` says why in plain words. */
export type Usage = { people: number; positions: number; records: boolean; reason: string | null };

/**
 * Whether saved reports, settings or the audit log of anything but `ownEntity` mention the id. Rewrites the ladder
 * made by itself (audited with LADDER_REASON) are not a use.
 */
export async function mentionedElsewhere(tx: Tx, id: string, ownEntity: string): Promise<boolean> {
  const like = `%${id}%`;
  const [audit] = await tx
    .select({ n: count() })
    .from(auditLog)
    .where(
      and(
        ne(auditLog.entityType, ownEntity),
        or(isNull(auditLog.reason), ne(auditLog.reason, LADDER_REASON)),
        or(sql`${auditLog.before}::text like ${like}`, sql`${auditLog.after}::text like ${like}`),
      ),
    );
  if (audit.n > 0) return true;
  const [reports] = await tx.select({ n: count() }).from(savedReports).where(sql`${savedReports.spec}::text like ${like}`);
  if (reports.n > 0) return true;
  const [setting] = await tx.select({ n: count() }).from(settings).where(sql`${settings.value}::text like ${like}`);
  return setting.n > 0;
}

/**
 * People who hold the rank, position types that would still list it once it left the ladder (lists that follow the
 * ladder let it go on their own), and past records: detail positions, saved reports, settings and the audit log.
 */
export async function rankUsage(tx: Tx, id: string): Promise<Usage> {
  const [people] = await tx.select({ n: count() }).from(users).where(eq(users.rankId, id));
  const all = await listRanks(tx);
  const outside = arrangeRanks(all, { kind: "ladder", id, inLadder: false });
  const types = await tx.select({ list: positionTypes.eligibleRankIds }).from(positionTypes).where(sql`${id} = any(${positionTypes.eligibleRankIds})`);
  const positions = { n: types.filter((t) => relinkRanks(t.list, all, outside).includes(id)).length };
  const [overrides] = await tx.select({ n: count() }).from(jobPositions).where(sql`${id} = any(${jobPositions.eligibleRankIdsOverride})`);
  const records = overrides.n > 0 || (await mentionedElsewhere(tx, id, "rank"));
  let reason: string | null = null;
  if (people.n > 0) reason = people.n === 1 ? "Used by 1 person" : `Used by ${people.n} people`;
  else if (positions.n > 0) reason = positions.n === 1 ? "Used by 1 position type" : `Used by ${positions.n} position types`;
  else if (records) reason = "Used in past records";
  return { people: people.n, positions: positions.n, records, reason };
}

/** Deletes a rank added by mistake: one that nothing has ever used. Anything else is turned off instead. */
export async function deleteRank(actor: Actor, tx: Tx, id: string): Promise<void> {
  assertCan(actor, "rank.manage");
  const before = await getRank(tx, id);
  const usage = await rankUsage(tx, id);
  if (usage.reason) throw new RuleViolation([{ check: "rank.delete.unused", ok: false, message: `${before.name} cannot be deleted: ${usage.reason.toLowerCase()}. Turn it off instead.` }]);
  // A ladder rank first leaves the ladder, which takes it off the position types that follow it.
  if (before.inLadder) await applyRankChange(actor, tx, { kind: "ladder", id, inLadder: false });
  await tx.delete(ranks).where(eq(ranks.id, id));
  await recordAudit(tx, { actor, action: "rank.delete", entityType: "rank", entityId: id, before, after: null });
}

