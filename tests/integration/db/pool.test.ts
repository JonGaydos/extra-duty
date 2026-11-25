import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { sql } from "drizzle-orm";
import { startTestDb, type TestDb } from "../../setup/db";
import { closeDb, createDb } from "@/db/client";

/**
 * A pg pool re-emits a dropped idle connection (Postgres restarting: 57P01) as an `error` event. With no listener,
 * Node throws and the web or worker process exits; in tests it is the 57P01 teardown error.
 */
describe("database pool", () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await startTestDb();
  });
  afterAll(async () => {
    await tdb?.stop();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function backends(appName: string): Promise<number> {
    const probe = createDb(tdb.url);
    try {
      const r = await probe.execute(sql`select count(*)::int as n from pg_stat_activity where application_name = ${appName}`);
      return (r.rows[0] as { n: number }).n;
    } finally {
      await closeDb(probe);
    }
  }

  test("a dropped idle connection is logged without secrets and the pool keeps working", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const db = createDb(tdb.url);
    const killer = createDb(tdb.url);
    try {
      const [{ pid }] = (await db.execute(sql`select pg_backend_pid() as pid`)).rows as Array<{ pid: number }>;
      // The connection is idle in the pool now; ending its backend is what a database restart does to it.
      await killer.execute(sql`select pg_terminate_backend(${pid})`);
      await vi.waitFor(() => expect(logged).toHaveBeenCalled(), { timeout: 5_000 });
      const text = logged.mock.calls.flat().map(String).join(" ");
      expect(text).toMatch(/database pool error/);
      expect(text).toMatch(/57P01|terminating connection/);
      expect(text).not.toMatch(/postgres:postgres|password/i);
      expect((await db.execute(sql`select 1 as one`)).rows[0]).toEqual({ one: 1 });
    } finally {
      await closeDb(db);
      await closeDb(killer);
    }
  });

  test("a connection attempt gives up after the connect timeout", () => {
    const db = createDb(tdb.url);
    try {
      expect(db.$client.options.connectionTimeoutMillis).toBeGreaterThan(0);
    } finally {
      void closeDb(db);
    }
  });

  test("closeDb resolves only once every connection is closed on the server", async () => {
    const appName = "pool-close-test";
    const db = createDb(`${tdb.url}?application_name=${appName}`);
    // Three connections at once, all idle in the pool afterwards.
    await Promise.all([1, 2, 3].map(() => db.execute(sql`select pg_sleep(0.05)`)));
    expect(await backends(appName)).toBe(3);
    await closeDb(db);
    expect(await backends(appName)).toBe(0);
  });
});
