import EmbeddedPostgres from "embedded-postgres";
import { createServer } from "node:net";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runMigrations } from "../../src/db/migrate";

export interface TestDb {
  url: string;
  stop(): Promise<void>;
}

function openPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
  });
}

/**
 * Starts a throwaway Postgres (temp data dir, free port) and returns its URL.
 * Call once per test file (beforeAll) and stop() in afterAll.
 * All Drizzle migrations are applied before it returns. `port` fixes the
 * port (the e2e server uses one known to every Playwright process).
 */
export async function startTestDb(opts: { port?: number } = {}): Promise<TestDb> {
  const dir = await mkdtemp(join(tmpdir(), "extra-duty-pg-"));
  const port = opts.port ?? (await openPort());
  const pg = new EmbeddedPostgres({
    databaseDir: dir,
    user: "postgres",
    password: "postgres",
    port,
    persistent: false,
    onLog: () => {},
    onError: (err) => console.error(err),
  });
  try {
    await pg.initialise();
    await pg.start();
    await pg.createDatabase("test");
    await runMigrations(`postgres://postgres:postgres@127.0.0.1:${port}/test`);
  } catch (err) {
    await pg.stop().catch(() => {});
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return {
    url: `postgres://postgres:postgres@127.0.0.1:${port}/test`,
    async stop() {
      try {
        await pg.stop();
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}
