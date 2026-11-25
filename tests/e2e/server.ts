/**
 * Playwright webServer: a fresh embedded Postgres with migrations, the seed
 * and the e2e accounts, then a production build of the app (`next build`,
 * `next start`, in .next-e2e so a running preview's .next is untouched) against it, so pages respond at real speed. Next's output
 * goes to test-results/e2e-server.log. SIGTERM or SIGINT stops Next and
 * Postgres.
 */
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, openSync } from "node:fs";
import { eq, sql } from "drizzle-orm";
import { startTestDb } from "../setup/db";
import { createDb, runInMode } from "@/db/client";
import { seedDemo } from "@/db/demo-seed";
import { runMigrations } from "@/db/migrate";
import { seed } from "@/db/seed";
import { ranks, settings, users, vendors, vendorUsers } from "@/db/schema";
import { DEFAULT_SETTINGS } from "@/domain/settings/defaults";
import { E2E, E2E_USERS } from "./env";
import { seedCoordinator } from "./coordinator-fixtures";
import { seedPersonnel } from "./personnel-fixtures";
import { seedAdmin } from "./admin-fixtures";
import { seedVendor } from "./vendor-fixtures";
import { startFakeNominatim } from "./fake-nominatim";

// E2E_DEMO=staging runs the site as staging on the demo agency (for scripts/capture-screenshots.ts): the live
// database holds the demo data instead of the e2e accounts.
const stagingDemo = process.env.E2E_DEMO === "staging";
const tdb = await startTestDb({ port: E2E.dbPort });
const db = createDb(tdb.url);
async function seedE2E(): Promise<void> {
  await seed(db);
  // A made-up agency name, the same one the demo data uses.
  await db.insert(settings).values({ value: { agency: { ...DEFAULT_SETTINGS.agency, name: "Bayside County Sheriff's Office" } } });
  const [deputyRank] = await db.select({ id: ranks.id }).from(ranks).where(eq(ranks.name, "Deputy Sheriff"));
  const [vendor] = await db.insert(vendors).values({ name: "Lakeview Community" }).returning();
  for (const u of Object.values(E2E_USERS)) {
    const [row] = await db
      .insert(users)
      .values({
        name: u.name,
        email: u.email,
        emailVerified: true,
        role: u.role,
        rankId: u.role === "personnel" ? deputyRank.id : null,
      })
      .returning();
    if (u.role === "vendor") await db.insert(vendorUsers).values({ userId: row.id, vendorId: vendor.id });
  }
  await seedPersonnel(db);
  await seedCoordinator(db);
  await seedAdmin(db);
  await seedVendor(db);
}
try {
  if (stagingDemo) {
    Object.assign(process.env, { STORAGE_DRIVER: "local", STORAGE_LOCAL_DIR: "test-results/e2e-storage" });
    await runInMode("live", () => seedDemo(db));
  } else await seedE2E();
  // Training mode: its own database on the same server, with the demo data, and its own file folder.
  await db.execute(sql`create database training`);
} finally {
  await db.$client.end();
}
await runMigrations(E2E.trainingDatabaseURL);
Object.assign(process.env, { STORAGE_DRIVER: "local", TRAINING_STORAGE_LOCAL_DIR: E2E.appEnv.TRAINING_STORAGE_LOCAL_DIR });
const training = createDb(E2E.trainingDatabaseURL);
try {
  await runInMode("training", () => seedDemo(training));
} finally {
  await training.$client.end();
}

mkdirSync("test-results", { recursive: true });
const log = openSync("test-results/e2e-server.log", "w");
const nominatim = await startFakeNominatim(E2E.nominatimPort);
const env = { ...process.env, ...E2E.appEnv, ...(stagingDemo ? { APP_ENV: "staging", STORAGE_LOCAL_DIR: "test-results/e2e-storage" } : {}), DATABASE_URL: tdb.url, NEXT_DIST_DIR: ".next-e2e", NOMINATIM_URL: `http://127.0.0.1:${E2E.nominatimPort}/search` };
// E2E_REUSE_BUILD=1 starts the last e2e build as is (faster reruns); leave it off after changing app code.
const reuse = process.env.E2E_REUSE_BUILD === "1" && existsSync(".next-e2e/BUILD_ID");
const build = reuse ? { status: 0 } : spawnSync("node_modules/.bin/next", ["build"], { stdio: ["ignore", log, log], env });
if (build.status !== 0) {
  nominatim.close();
  await tdb.stop();
  console.error("next build failed; see test-results/e2e-server.log");
  process.exit(1);
}
const next = spawn("node_modules/.bin/next", ["start", "--port", String(E2E.port)], { stdio: ["ignore", log, log], env });

let stopping = false;
async function stop(code: number): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (next.exitCode === null && next.signalCode === null) {
    next.kill("SIGTERM");
    await once(next, "exit");
  }
  nominatim.close();
  await tdb.stop();
  process.exit(code);
}

process.on("SIGTERM", () => void stop(0));
process.on("SIGINT", () => void stop(0));
next.on("exit", (code) => void stop(code ?? 1));
