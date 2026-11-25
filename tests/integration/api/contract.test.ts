import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { z } from "zod";
import { useApiDb, bearer, call, sessionToken } from "./helpers";
import { makeUser } from "../users/helpers";
import { ranks, users } from "@/db/schema";
import { seed } from "@/db/seed";
import { eq } from "drizzle-orm";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { apiHandler } from "@/lib/api/handler";
import { TooLargeError } from "@/app/api/v1/files";
import { GET as openapi } from "@/app/api/v1/openapi.json/route";
import { GET as listJobs } from "@/app/api/v1/jobs/route";
import { GET as getJob } from "@/app/api/v1/jobs/[id]/route";
import { getJob as getJobService } from "@/domain/jobs/jobs";
import { vendorViewJob } from "@/domain/vendor-portal/requests";

const ROOT = join(process.cwd(), "src/app/api/v1");

function routeFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) return routeFiles(p);
    return name === "route.ts" ? [p] : [];
  });
}

/** `src/app/api/v1/jobs/[id]/route.ts` is `/jobs/{id}`. */
function apiPath(file: string): string {
  const parts = relative(ROOT, file).split(sep).slice(0, -1);
  return `/${parts.map((s) => s.replace(/^\[(.+)\]$/, "{$1}")).join("/")}`;
}

describe("the API contract", () => {
  const get = useApiDb();
  let token: string;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    const coord = await makeUser(db, "coordinator", "contract-coord@example.test");
    token = await sessionToken(db, coord.row.id);
  });

  test("every route under /api/v1 uses the handler and is in the OpenAPI document", async () => {
    const res = await call(openapi, "/api/v1/openapi.json");
    expect(res.status).toBe(200);
    const doc = (await res.json()) as { openapi: string; paths: Record<string, Record<string, unknown>> };
    expect(doc.openapi).toBe("3.1.0");
    const files = routeFiles(ROOT);
    expect(files.length).toBeGreaterThan(60);
    const missing: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      const methods = [...text.matchAll(/export (?:const|async function) (GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]);
      expect(methods.length, file).toBeGreaterThan(0);
      expect(text, `${file} uses apiHandler`).toContain("apiHandler(");
      for (const m of methods) if (!doc.paths[`/api/v1${apiPath(file)}`]?.[m.toLowerCase()]) missing.push(`${m} ${apiPath(file)}`);
    }
    expect(missing).toEqual([]);
  });

  test("a RuleViolation is 409 with the checks; other domain errors keep their status", async () => {
    const def = { method: "POST", path: "/test", summary: "Test", response: z.unknown() } as const;
    const checks = [{ check: "cap_week" as const, ok: false, message: "Over the weekly cap." }];
    const rule = await call(apiHandler(def, async () => { throw new RuleViolation(checks); }), "/api/v1/test", { method: "POST", headers: bearer(token) });
    expect(rule.status).toBe(409);
    expect(await rule.json()).toEqual({ error: { code: "rule_violation", message: "One or more rules were not met.", checks } });
    const cases: Array<[Error, number]> = [
      [new ForbiddenError(), 403],
      [new NotFoundError(), 404],
      [new ValidationError("Bad."), 400],
      [new TooLargeError(), 413],
    ];
    for (const [err, status] of cases) {
      const res = await call(apiHandler(def, async () => { throw err; }), "/api/v1/test", { method: "POST", headers: bearer(token) });
      expect(res.status, err.name).toBe(status);
    }
    const anon = await call(apiHandler(def, async () => ({ ok: true })), "/api/v1/test", { method: "POST" });
    expect(anon.status).toBe(401);
  });

  test("a body that fails its schema is 400, not a crash", async () => {
    const def = { method: "POST", path: "/test", summary: "Test", body: z.object({ n: z.number() }), response: z.unknown() } as const;
    const h = apiHandler(def, async ({ body }) => body);
    const bad = await call(h, "/api/v1/test", { method: "POST", headers: { ...bearer(token), "content-type": "application/json" }, body: JSON.stringify({ n: "x" }) });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error.message).toMatch(/^n: /);
    const notJson = await call(h, "/api/v1/test", { method: "POST", headers: bearer(token), body: "{" });
    expect(notJson.status).toBe(400);
  });

  test("a unique-constraint violation is a 400 validation error, not a 500", async () => {
    const def = { method: "POST", path: "/test", summary: "Test", response: z.unknown() } as const;
    const h = apiHandler(def, ({ run }) => run((tx) => tx.insert(ranks).values({ name: "Deputy Sheriff", sortOrder: 99 })));
    const res = await call(h, "/api/v1/test", { method: "POST", headers: bearer(token) });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("validation");
  });

  test("a malformed id in the path is 404, not a database error", async () => {
    const res = await call(getJob, "/api/v1/jobs/not-a-uuid", { headers: bearer(token), params: { id: "not-a-uuid" } });
    expect(res.status).toBe(404);
    const unknown = await call(getJob, "/api/v1/jobs/0190a7a4-0000-7000-8000-000000000000", { headers: bearer(token), params: { id: "0190a7a4-0000-7000-8000-000000000000" } });
    expect(unknown.status).toBe(404);
  });

  test("a malformed id reads as not found in the services behind the page routes too (ids are text, never cast)", async () => {
    const { db } = get();
    const coord = (await makeUser(db, "coordinator", "contract-pages@example.test")).actor;
    const vendor = { ...(await makeUser(db, "vendor", "contract-vendor@example.test")).actor, vendorId: "0190a7a4-0000-7000-8000-000000000001" };
    await expect(db.transaction((tx) => getJobService(coord, tx, "not-a-uuid"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.transaction((tx) => vendorViewJob(vendor, tx, "not-a-uuid", new Date()))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a session token sent as a bearer token works for GET /api/v1/jobs", async () => {
    const ok = await call(listJobs, "/api/v1/jobs?from=2026-03-08&to=2026-03-09", { headers: bearer(token) });
    expect(ok.status).toBe(200);
    expect(Array.isArray((await ok.json()).data)).toBe(true);
    const { db } = get();
    const expired = await sessionToken(db, (await makeUser(db, "personnel", "expired@example.test")).row.id, new Date(Date.now() - 1000));
    expect((await call(listJobs, "/api/v1/jobs", { headers: bearer(expired) })).status).toBe(401);
    const gone = await makeUser(db, "personnel", "gone@example.test");
    const goneToken = await sessionToken(db, gone.row.id);
    await db.update(users).set({ active: false }).where(eq(users.id, gone.row.id));
    expect((await call(listJobs, "/api/v1/jobs", { headers: bearer(goneToken) })).status).toBe(401);
    expect((await call(listJobs, "/api/v1/jobs", { headers: bearer("not-a-real-token") })).status).toBe(401);
  });
});
