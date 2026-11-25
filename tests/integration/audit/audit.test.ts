import { afterAll, beforeAll, expect, test } from "vitest";
import { startTestDb, type TestDb } from "../../setup/db";
import { closeDb, createDb, type Db } from "@/db/client";
import { users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError } from "@/domain/errors";
import { listAudit, recordAudit } from "@/domain/audit/audit";

let tdb: TestDb;
let db: Db;
let coordinator: Actor;
let personnel: Actor;

beforeAll(async () => {
  tdb = await startTestDb();
  db = createDb(tdb.url);
  const [c, p] = await db
    .insert(users)
    .values([
      { name: "Coord", email: "c@example.test", role: "coordinator" },
      { name: "Pers", email: "p@example.test", role: "personnel" },
    ])
    .returning();
  coordinator = { userId: c.id, role: "coordinator", rankId: null, vendorId: null };
  personnel = { userId: p.id, role: "personnel", rankId: null, vendorId: null };
});

afterAll(async () => {
  if (db) await closeDb(db);
  await tdb?.stop();
});

test("recordAudit stores the row, with null actor for system", async () => {
  await db.transaction(async (tx) => {
    await recordAudit(tx, {
      actor: coordinator,
      action: "job.create",
      entityType: "job",
      entityId: "j1",
      before: null,
      after: { title: "Parade" },
      reason: "test",
    });
    await recordAudit(tx, { actor: "system", action: "job.release", entityType: "job", entityId: "j1" });
  });
  const rows = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: "j1" }, 1));
  expect(rows).toHaveLength(2);
  const sys = rows.find((r) => r.action === "job.release")!;
  expect(sys.actorUserId).toBeNull();
  const mine = rows.find((r) => r.action === "job.create")!;
  expect(mine.actorUserId).toBe(coordinator.userId);
  expect(mine.after).toEqual({ title: "Parade" });
  expect(mine.reason).toBe("test");
});

test("listAudit rejects personnel and allows coordinator", async () => {
  await db.transaction(async (tx) => {
    await expect(listAudit(personnel, tx, {}, 1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAudit({ ...personnel, role: "vendor" }, tx, {}, 1)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listAudit(coordinator, tx, {}, 1)).resolves.toBeInstanceOf(Array);
  });
});

test("filter by entity returns only matching rows, newest first, 50 per page", async () => {
  for (let i = 0; i < 52; i++) {
    await db.transaction((tx) =>
      recordAudit(tx, { actor: coordinator, action: `n${i}`, entityType: "shift", entityId: "s1" }),
    );
  }
  await db.transaction((tx) =>
    recordAudit(tx, { actor: coordinator, action: "other", entityType: "shift", entityId: "s2" }),
  );
  const p1 = await db.transaction((tx) => listAudit(coordinator, tx, { entityType: "shift", entityId: "s1" }, 1));
  const p2 = await db.transaction((tx) => listAudit(coordinator, tx, { entityType: "shift", entityId: "s1" }, 2));
  expect(p1).toHaveLength(50);
  expect(p2).toHaveLength(2);
  expect(p1[0].action).toBe("n51");
  expect(p2[1].action).toBe("n0");
  expect([...p1, ...p2].every((r) => r.entityId === "s1")).toBe(true);
});
