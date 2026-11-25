import { createServer } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { useTestDb } from "../setup/test-db";
import { closeDb, liveDb } from "@/db/client";
import { GET } from "@/app/api/health/route";

/** A port nothing listens on. */
async function closedPort(): Promise<number> {
  const srv = createServer();
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
  const { port } = srv.address() as { port: number };
  await new Promise<void>((r) => srv.close(() => r()));
  return port;
}

describe("/api/health", () => {
  const get = useTestDb();
  beforeAll(() => {
    process.env.DATABASE_URL = get().url;
  });
  afterAll(async () => {
    await closeDb(liveDb).catch(() => {});
  });

  test("200 with the database, the queue and APP_ENV", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ status: "ok", appEnv: "production", database: "ok", queue: "ok", training: "off" });
  });

  test("503 when the database is down, without the error's details", async () => {
    const url = process.env.DATABASE_URL!;
    process.env.DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${await closedPort()}/test`;
    try {
      const res = await GET();
      expect(res.status).toBe(503);
      const body = await res.json();
      expect(body).toMatchObject({ status: "unavailable", appEnv: "production", database: "down", queue: "down" });
      expect(JSON.stringify(body)).not.toMatch(/ECONNREFUSED|postgres:/);
    } finally {
      await closeDb(liveDb).catch(() => {});
      process.env.DATABASE_URL = url;
    }
  });
});
