import { afterAll, beforeAll } from "vitest";
import { startTestDb, type TestDb } from "./db";
import { closeDb, createDb, type Db } from "@/db/client";

/**
 * Call inside a describe block (or at file top level). Starts the embedded
 * Postgres in beforeAll and, in afterAll, ends the pg pool BEFORE stopping
 * Postgres so tests never hit the 57P01 termination error.
 */
export function useTestDb(): () => { db: Db; url: string } {
  let tdb: TestDb | undefined;
  let db: Db | undefined;
  beforeAll(async () => {
    tdb = await startTestDb();
    db = createDb(tdb.url);
  });
  afterAll(async () => {
    if (db) await closeDb(db);
    await tdb?.stop();
  });
  return () => {
    if (!db || !tdb) throw new Error("Test database is not ready.");
    return { db, url: tdb.url };
  };
}
