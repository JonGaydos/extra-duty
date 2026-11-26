import { afterAll, beforeAll, expect, test } from "vitest";
import { startTestDb, type TestDb } from "../../setup/db";
import { closeDb, createDb } from "@/db/client";
import { seed } from "@/db/seed";
import { positionTypes, ranks, seasons, users } from "@/db/schema";
import { byText } from "@/lib/sort";

let testDb: TestDb;
const db = () => createDb(testDb.url);

beforeAll(async () => {
  testDb = await startTestDb();
});

afterAll(async () => {
  await testDb?.stop();
});

test("seed is idempotent and creates the defaults", async () => {
  const d = db();
  try {
    await seed(d, { adminEmail: "Admin@Example.com" });
    await seed(d, { adminEmail: "admin@example.com" });
    const rankRows = await d.select().from(ranks);
    expect(rankRows.map((r) => r.name).sort(byText)).toEqual(["CSO", "Deputy Sheriff", "Dispatcher", "Posse"]);
    expect(rankRows.find((r) => r.name === "Dispatcher")?.inLadder).toBe(false);
    expect(await d.select().from(positionTypes)).toHaveLength(6);
    const season = await d.select().from(seasons);
    expect(season).toHaveLength(1);
    expect(season[0]).toMatchObject({ rollingCapMinutes: 960, weekCapMinutes: null, monthCapMinutes: null });
    const admins = await d.select().from(users);
    expect(admins).toHaveLength(1);
    expect(admins[0]).toMatchObject({ email: "admin@example.com", role: "admin" });
  } finally {
    await closeDb(d);
  }
});
