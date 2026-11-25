import { eq, sql } from "drizzle-orm";
import { currentMode, type Tx } from "@/db/client";
import { buildDemoData, loadDemoData } from "@/db/demo-seed";
import { users } from "@/db/schema";
import { seedInTx } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { loadActiveActor } from "@/domain/auth/sign-in-policy";
import { ValidationError } from "@/domain/errors";

/** The database name in a Postgres URL. */
function databaseName(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return decodeURIComponent(new URL(url).pathname.replace(/^\//, "")) || null;
  } catch {
    return null;
  }
}

/**
 * Refuses unless `tx` is the training database: the work must run in training mode, and the connected database must
 * be the one named in TRAINING_DATABASE_URL, never the live one.
 */
async function assertTrainingDatabase(tx: Tx): Promise<void> {
  const refuse = () => new ValidationError("Training data can be reset only in training mode, on the training database.");
  if (currentMode() !== "training") throw refuse();
  const training = process.env.TRAINING_DATABASE_URL;
  if (!training || training === process.env.DATABASE_URL) throw refuse();
  const { rows } = await tx.execute<{ name: string }>(sql`select current_database() as name`);
  if (rows[0]?.name !== databaseName(training)) throw refuse();
}

/**
 * Wipes the training database and reloads the built-in seed and the demo data for `now`. Coordinators and admins
 * (practicing in training), or the nightly job ("system"). Never on the live database. Audited as the same demo
 * person after the reload (their row is recreated).
 */
export async function resetTrainingData(actor: Actor | "system", tx: Tx, now: Date = new Date()): Promise<void> {
  if (actor !== "system") assertCan(actor, "training.reset");
  await assertTrainingDatabase(tx);
  const email = actor === "system" ? null : (await tx.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)))[0]?.email;
  // Every app table; the migrations and the queue live in other schemas. No RESTART IDENTITY: that needs the
  // sequences' owner, and the app's database role is not (detail and invoice numbers simply continue).
  const { rows } = await tx.execute<{ name: string }>(sql`select tablename as name from pg_tables where schemaname = 'public'`);
  if (rows.length) await tx.execute(sql.raw(`truncate table ${rows.map((r) => `"public"."${r.name}"`).join(", ")} cascade`));
  await seedInTx(tx);
  const data = buildDemoData(now);
  await loadDemoData(tx, data);
  const by = email ? data.users.find((u) => u.email === email) : undefined;
  await recordAudit(tx, {
    actor: (by && (await loadActiveActor(tx, by.id))) || "system",
    action: "training.reset",
    entityType: "training",
    entityId: "training",
    after: { jobs: data.jobs.length, invoices: data.invoices.length, users: data.users.length },
  });
}
