import { AsyncLocalStorage } from "node:async_hooks";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "./schema";

/** How long a new connection may take before the attempt fails (a down database answers fast instead of hanging). */
const CONNECT_TIMEOUT_MS = 10_000;

export function createDb(url: string) {
  const pool = new Pool({ connectionString: url, connectionTimeoutMillis: CONNECT_TIMEOUT_MS });
  // An idle connection the server drops (a restart: 57P01) is re-emitted here; without a listener Node would exit.
  // The pool has already discarded that connection and opens a new one on the next query. Only the code and the
  // message are logged: the error object carries the client, connection settings and password included.
  pool.on("error", (err: Error & { code?: string }) => {
    const code = err.code ? ` (${err.code})` : "";
    console.error(`database pool error${code}: ${err.message}`);
  });
  return drizzle(pool, { schema });
}

export type Db = ReturnType<typeof createDb>;

/**
 * Ends the pool and waits until every connection is closed. `pool.end()` alone resolves as soon as the pool lets
 * go of its connections, before their sockets close, so stopping Postgres right after it can still reach them.
 */
export async function closeDb(db: Db): Promise<void> {
  const pool = db.$client;
  if (pool.ended || pool.ending) return;
  let open = pool.totalCount;
  const closed = new Promise<void>((resolve) => {
    if (open === 0) return resolve();
    pool.on("remove", () => {
      if (--open <= 0) resolve();
    });
  });
  await pool.end();
  await closed;
}
export type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Live data, or the training copy (its own database and storage). */
export type DataMode = "live" | "training";

export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;

// Kept on globalThis: Next compiles instrumentation and each route separately, so every bundle gets its own copy
// of this module, and the connections and the current mode must be shared inside one Node process.
const KEY = Symbol.for("extra-duty.data-mode");
type State = { dbs: Partial<Record<DataMode, { url: string; db: Db }>>; mode: AsyncLocalStorage<DataMode> };
const globals = globalThis as Record<symbol, unknown>;
globals[KEY] ??= { dbs: {}, mode: new AsyncLocalStorage<DataMode>() };
const state = globals[KEY] as State;

/** The mode the current work runs in: set by the one request wrapper (and the worker), live everywhere else. */
export function currentMode(): DataMode {
  return state.mode.getStore() ?? "live";
}

/** Runs `fn`, and everything it awaits, in `mode`: `db`, `withTx`, storage, the queue and email follow it. */
export function runInMode<T>(mode: DataMode, fn: () => T): T {
  return state.mode.run(mode, fn);
}

/** True when this deployment has a training database (TRAINING_DATABASE_URL). */
export function trainingConfigured(): boolean {
  return Boolean(process.env.TRAINING_DATABASE_URL);
}

export function databaseUrl(mode: DataMode): string {
  const name = mode === "live" ? "DATABASE_URL" : "TRAINING_DATABASE_URL";
  const url = process.env[name];
  if (!url) throw new Error(`${name} is not set`);
  return url;
}

/** The connection for `mode`, opened on first use (and again if its URL changed or its pool was ended). */
export function dbFor(mode: DataMode): Db {
  const url = databaseUrl(mode);
  const cur = state.dbs[mode];
  if (cur?.url === url && !cur.db.$client.ended) return cur.db;
  // A replaced pool (its URL changed) is closed, so it holds no idle connections.
  if (cur && !cur.db.$client.ended) cur.db.$client.end().catch(() => {});
  const next = { url, db: createDb(url) };
  state.dbs[mode] = next;
  return next.db;
}

/** A transaction runner on `mode`'s database that also runs the work in that mode. */
export function runnerFor(mode: DataMode): TxRunner {
  return (fn) => runInMode(mode, () => dbFor(mode).transaction(fn));
}

function bound(pick: () => Db): Db {
  return new Proxy({} as Db, {
    get(_t, prop) {
      const real = pick();
      const value = Reflect.get(real, prop, real);
      return typeof value === "function" ? value.bind(real) : value;
    },
  });
}

/**
 * The database of the current mode (see runInMode), bound on first use, so importing never connects. Services take
 * their Tx from the request wrapper and never choose a database themselves.
 */
export const db: Db = bound(() => dbFor(currentMode()));

/** Always the live database, whatever the mode: sign-in, sessions and API keys live only there. */
export const liveDb: Db = bound(() => dbFor("live"));

export function withTx<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  return dbFor(currentMode()).transaction(fn);
}
