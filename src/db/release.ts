/**
 * The release step (ROLE=migrate): runs exactly once per deploy, before web and the worker start. For the live
 * database, and the training database when TRAINING_DATABASE_URL is set: applies the migrations, installs or
 * upgrades the pg-boss schema and queues, and runs the idempotent built-in seed (ranks, types, built-in reports;
 * settings defaults need no row). The demo data is loaded where a database has none yet: always for training, and
 * for the live database on staging, which runs on demo data. This is the only step that needs DDL rights.
 */
import { count } from "drizzle-orm";
import { fileURLToPath } from "node:url";
import { createDb, runInMode, type DataMode } from "./client";
import { seedDemo } from "./demo-seed";
import { runMigrations } from "./migrate";
import { vendors } from "./schema";
import { seed } from "./seed";
import { appEnvFromProcess } from "../lib/env";

async function prepare(mode: DataMode, url: string, opts: { adminEmail?: string; demoIfEmpty: boolean }): Promise<void> {
  await runMigrations(url);
  const db = createDb(url);
  try {
    await seed(db, { adminEmail: opts.adminEmail });
    if (opts.demoIfEmpty && (await db.select({ n: count() }).from(vendors))[0].n === 0) {
      // In the database's own mode, so the demo files go to its own storage.
      await runInMode(mode, () => seedDemo(db));
      console.log(`release: demo data loaded (${mode})`);
    }
  } finally {
    await db.$client.end();
  }
  console.log(`release: ${mode} database migrated and seeded`);
}

export async function release(): Promise<void> {
  const live = process.env.DATABASE_URL;
  if (!live) throw new Error("DATABASE_URL is not set");
  const staging = appEnvFromProcess() === "staging";
  if (!process.env.SEED_ADMIN_EMAIL && !staging) console.warn("release: SEED_ADMIN_EMAIL is not set; no first admin is created");
  await prepare("live", live, { adminEmail: process.env.SEED_ADMIN_EMAIL, demoIfEmpty: staging });
  const training = process.env.TRAINING_DATABASE_URL;
  if (training) await prepare("training", training, { demoIfEmpty: true });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  release().then(
    () => process.exit(0),
    (err) => {
      console.error("release failed:", err);
      process.exit(1);
    },
  );
}
