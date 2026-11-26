import { sql } from "drizzle-orm";
import { dbFor, trainingConfigured, type DataMode } from "@/db/client";
import { appEnvFromProcess } from "@/lib/env";

export const dynamic = "force-dynamic";

const TIMEOUT_MS = 3000;

function withTimeout<T>(p: Promise<T>): Promise<T> {
  return Promise.race([p, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("timed out")), TIMEOUT_MS).unref())]);
}

type Check = "ok" | "down";

async function check(mode: DataMode): Promise<{ database: Check; queue: Check }> {
  const db = dbFor(mode);
  try {
    await withTimeout(db.execute(sql`select 1`));
  } catch {
    return { database: "down", queue: "down" };
  }
  try {
    // The queue is pg-boss in the same database; installed by the release step.
    await withTimeout(db.execute(sql`select version from pgboss.version`));
    return { database: "ok", queue: "ok" };
  } catch {
    return { database: "ok", queue: "down" };
  }
}

/** The training database: off when there is none, else whether it answers. */
async function trainingStatus(): Promise<"ok" | "down" | "off"> {
  if (!trainingConfigured()) return "off";
  return (await check("training")).database === "ok" ? "ok" : "down";
}

/**
 * For the container health check and uptime monitors: 200 when the live database and the queue answer, 503
 * otherwise. Public, and it never shows error details. The training database is reported but never fails the check.
 */
export async function GET(): Promise<Response> {
  const live = await check("live");
  const training = await trainingStatus();
  const ok = live.database === "ok" && live.queue === "ok";
  return Response.json(
    { status: ok ? "ok" : "unavailable", appEnv: appEnvFromProcess(), ...live, training },
    { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } },
  );
}
