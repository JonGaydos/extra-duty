import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { ranks, users } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, RuleViolation } from "@/domain/errors";
import { listAudit } from "@/domain/audit/audit";
import { createRank, deactivateRank, listRanks, reorderRanks } from "@/domain/ranks/ranks";

describe("ranks", () => {
  const get = useTestDb();
  let coordinator: Actor;
  let personnel: Actor;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    const rows = await db
      .insert(users)
      .values([
        { name: "Coord", email: "c@example.test", role: "coordinator" },
        { name: "Pers", email: "p@example.test", role: "personnel" },
      ])
      .returning();
    coordinator = { userId: rows[0].id, role: "coordinator", rankId: null, vendorId: null };
    personnel = { userId: rows[1].id, role: "personnel", rankId: null, vendorId: null };
  });

  test("listRanks returns seeded ranks in sort order", async () => {
    const { db } = get();
    const list = await db.transaction((tx) => listRanks(tx));
    expect(list.map((r) => r.name)).toEqual(["Posse", "CSO", "Deputy Sheriff", "Dispatcher"]);
  });

  test("personnel cannot manage ranks", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => createRank(personnel, tx, { name: "X", sortOrder: 50 }))).rejects.toBeInstanceOf(
      ForbiddenError,
    );
  });

  test("createRank inserts and audits", async () => {
    const { db } = get();
    const r = await db.transaction((tx) => createRank(coordinator, tx, { name: "Cadet", sortOrder: 10 }));
    expect(r).toMatchObject({ name: "Cadet", sortOrder: 10, inLadder: true, active: true });
    const rows = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: r.id }, 1));
    expect(rows.map((a) => a.action)).toEqual(["rank.create"]);
  });

  test("reorderRanks rewrites sortOrder 1..n and audits", async () => {
    const { db } = get();
    const before = await db.transaction((tx) => listRanks(tx));
    const ids = before.map((r) => r.id).reverse();
    await db.transaction((tx) => reorderRanks(coordinator, tx, ids));
    const after = await db.transaction((tx) => listRanks(tx));
    expect(after.map((r) => r.id)).toEqual(ids);
    expect(after.map((r) => r.sortOrder)).toEqual(ids.map((_, i) => i + 1));
    const rows = await db.transaction((tx) => listAudit(coordinator, tx, { entityType: "rank" }, 1));
    expect(rows.some((a) => a.action === "rank.reorder")).toBe(true);
  });

  test("reorderRanks rejects an incomplete id list", async () => {
    const { db } = get();
    const list = await db.transaction((tx) => listRanks(tx));
    await expect(
      db.transaction((tx) => reorderRanks(coordinator, tx, list.slice(1).map((r) => r.id))),
    ).rejects.toBeInstanceOf(RuleViolation);
  });

  test("deactivating a rank users still hold throws RuleViolation", async () => {
    const { db } = get();
    const [posse] = await db.select().from(ranks).where(eq(ranks.name, "Posse"));
    await db.insert(users).values({ name: "Holder", email: "h@example.test", rankId: posse.id });
    await expect(db.transaction((tx) => deactivateRank(coordinator, tx, posse.id))).rejects.toBeInstanceOf(
      RuleViolation,
    );
  });

  test("deactivateRank deactivates an unused rank and audits", async () => {
    const { db } = get();
    const [cadet] = await db.select().from(ranks).where(eq(ranks.name, "Cadet"));
    await db.transaction((tx) => deactivateRank(coordinator, tx, cadet.id));
    const [row] = await db.select().from(ranks).where(eq(ranks.id, cadet.id));
    expect(row.active).toBe(false);
    const rows = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: cadet.id }, 1));
    expect(rows.some((a) => a.action === "rank.deactivate")).toBe(true);
  });
});
