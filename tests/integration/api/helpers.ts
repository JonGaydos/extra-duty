import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { afterAll, beforeAll } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { sessions } from "@/db/schema";
import { closeDb, db as appDb, type Db } from "@/db/client";

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;

/**
 * A test database that the app's own `db` (and so every route) also uses: DATABASE_URL points at it before the
 * first query, and files go to a temporary local directory. The app's pool is ended before Postgres stops.
 */
export function useApiDb(): () => { db: Db; url: string } {
  const get = useTestDb();
  beforeAll(async () => {
    process.env.DATABASE_URL = get().url;
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-api-"));
  });
  // Runs before useTestDb's afterAll (hooks unwind in reverse), so the app's pool ends before Postgres stops.
  afterAll(async () => {
    await closeDb(appDb);
  });
  return get;
}

/** Calls a route handler the way Next does. */
export function call(handler: Handler, path: string, init: RequestInit & { params?: Record<string, string> } = {}): Promise<Response> {
  const { params, ...rest } = init;
  return handler(new Request(`http://localhost${path}`, rest), { params: Promise.resolve(params ?? {}) });
}

export const bearer = (token: string): HeadersInit => ({ authorization: `Bearer ${token}` });

/** A live sign-in session for the user, as the native app would hold it. */
export async function sessionToken(db: Db, userId: string, expiresAt = new Date(Date.now() + 3_600_000)): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  await db.insert(sessions).values({ token, userId, expiresAt });
  return token;
}
