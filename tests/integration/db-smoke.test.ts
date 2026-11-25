import { afterAll, beforeAll, expect, test } from "vitest";
import { Client } from "pg";
import { startTestDb, type TestDb } from "../setup/db";

let db: TestDb;

beforeAll(async () => {
  db = await startTestDb();
});

afterAll(async () => {
  await db?.stop();
});

test("select 1 returns 1 from the embedded database", async () => {
  const client = new Client({ connectionString: db.url });
  await client.connect();
  try {
    const res = await client.query("select 1 as one");
    expect(res.rows[0].one).toBe(1);
  } finally {
    await client.end();
  }
});
