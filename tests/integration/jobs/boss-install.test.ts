import { afterAll, describe, expect, test } from "vitest";
import { sql } from "drizzle-orm";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { useTestDb } from "../../setup/test-db";
import { closeDb, createDb } from "@/db/client";
import { migrationsFolder } from "@/db/migrate";
import { EMAIL_QUEUES, getBoss, stopBoss } from "@/jobs/boss";
import { SCHEDULE, tickQueue } from "@/jobs/schedule";

describe("pg-boss is installed by the release step only", () => {
  const get = useTestDb();
  afterAll(async () => {
    await stopBoss();
  });

  test("the migrate step installs the pg-boss schema with every email and tick queue", async () => {
    const { db } = get();
    const rows = await db.execute<{ name: string }>(sql`select name from pgboss.queue`);
    const names = rows.rows.map((r) => r.name);
    for (const q of [...EMAIL_QUEUES, ...SCHEDULE.map(tickQueue)]) expect(names).toContain(q);
  });

  test("at runtime pg-boss never installs its schema (migrate: false), so the app role needs no DDL rights", async () => {
    const { db } = get();
    await db.execute(sql`create database bare`);
    const bareUrl = get().url.replace(/\/test$/, "/bare");
    const bare = createDb(bareUrl);
    try {
      await migrate(bare, { migrationsFolder });
      process.env.DATABASE_URL = bareUrl;
      await expect(getBoss()).rejects.toThrow();
      const schema = await bare.execute(sql`select 1 from information_schema.schemata where schema_name = 'pgboss'`);
      expect(schema.rows).toHaveLength(0);
    } finally {
      await stopBoss();
      await closeDb(bare);
    }
  });
});
