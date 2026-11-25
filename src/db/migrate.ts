import { migrate } from "drizzle-orm/node-postgres/migrator";
import { fileURLToPath } from "node:url";
import { installBoss } from "../jobs/boss";
import { SCHEDULE, tickQueue } from "../jobs/schedule";
import { createDb } from "./client";

export const migrationsFolder = fileURLToPath(new URL("./migrations", import.meta.url));

/**
 * Applies all pending migrations, then installs or upgrades the pg-boss schema and its queues, and closes its own
 * connections. This is the only step that needs DDL rights.
 */
export async function runMigrations(url: string): Promise<void> {
  const db = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await db.$client.end();
  }
  await installBoss(url, SCHEDULE.map(tickQueue));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is not set");
    process.exit(1);
  }
  await runMigrations(url);
  console.log("db:migrate: migrations applied");
}
