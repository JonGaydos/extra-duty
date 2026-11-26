import { inflateRawSync } from "node:zlib";
import { beforeAll, describe, expect, test } from "vitest";
import { getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import { useApiDb, bearer, call, sessionToken } from "./helpers";
import { makeUser } from "../users/helpers";
import * as schema from "@/db/schema";
import { accounts, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { createApiKey } from "@/domain/api-keys/api-keys";
import { EXCLUDED_TABLES, EXPORT_TABLES, exportCoverage } from "@/domain/export/export";
import { GET as dataGet } from "@/app/api/v1/data/[entity]/route";
import { GET as exportGet } from "@/app/api/v1/export/route";
import { byText } from "@/lib/sort";

/** Reads a zip's entries (stored or deflated) into name -> text. */
function unzip(buf: Buffer): Map<string, string> {
  const out = new Map<string, string>();
  // The central directory lists every entry with its sizes and local header offset.
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString("utf8");
    const lNameLen = buf.readUInt16LE(local + 26);
    const lExtraLen = buf.readUInt16LE(local + 28);
    const start = local + 30 + lNameLen + lExtraLen;
    const raw = buf.subarray(start, start + csize);
    out.set(name, (method === 8 ? inflateRawSync(raw) : raw).toString("utf8"));
    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

describe("full data access", () => {
  const get = useApiDb();
  let admin: Actor;
  let readKey: string;
  let adminSecretMarker: string;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    const a = await makeUser(db, "admin", "data-admin@example.test");
    admin = a.actor;
    readKey = (await db.transaction((tx) => createApiKey(admin, tx, { name: "Data reader", scopes: ["read"] }))).key;
    adminSecretMarker = await sessionToken(db, a.row.id);
    await db.insert(accounts).values({ accountId: a.row.id, providerId: "credential", userId: a.row.id, password: "scrypt$very-secret-password-hash" });
    for (let i = 0; i < 5; i++) await db.insert(vendors).values({ name: `Paged Vendor ${i}`, active: i !== 4 });
  });

  const data = (path: string, entity: string) => call(dataGet, path, { headers: bearer(readKey), params: { entity } });

  test("every table except auth secrets is an entity, paged by cursor", async () => {
    const first = await data("/api/v1/data/vendors?limit=2", "vendors");
    expect(first.status).toBe(200);
    const page1 = (await first.json()) as { data: Array<{ id: string; name: string }>; nextCursor: string | null };
    expect(page1.data).toHaveLength(2);
    expect(page1.nextCursor).toBe(page1.data[1].id);
    const second = (await (await data(`/api/v1/data/vendors?limit=2&cursor=${page1.nextCursor}`, "vendors")).json()) as typeof page1;
    expect(second.data[0].id > page1.data[1].id).toBe(true);
    for (const entity of ["users", "vendors", "jobs", "job_positions", "assignments", "invoices", "invoice_events", "payment_issues", "ops_plans", "audit_log", "api_keys"]) {
      expect((await data(`/api/v1/data/${entity}`, entity)).status, entity).toBe(200);
    }
    for (const secret of ["sessions", "accounts", "verifications", "two_factors", "invites", "auth_throttle", "nothing"]) {
      expect((await data(`/api/v1/data/${secret}`, secret)).status, secret).toBe(404);
    }
  });

  test("updatedSince and column filters narrow the rows", async () => {
    const future = encodeURIComponent(new Date(Date.now() + 86_400_000).toISOString());
    const none = (await (await data(`/api/v1/data/vendors?updatedSince=${future}`, "vendors")).json()) as { data: unknown[] };
    expect(none.data).toHaveLength(0);
    const inactive = (await (await data("/api/v1/data/vendors?active=false", "vendors")).json()) as { data: Array<{ name: string }> };
    expect(inactive.data.map((v) => v.name)).toEqual(["Paged Vendor 4"]);
    expect((await data("/api/v1/data/vendors?updatedSince=yesterday", "vendors")).status).toBe(400);
    expect((await data("/api/v1/data/vendors?notAColumn=1", "vendors")).status).toBe(400);
  });

  test("secret columns never leave: no key hashes, token hashes, encrypted links or push keys", async () => {
    const keys = (await (await data("/api/v1/data/api_keys", "api_keys")).json()) as { data: Array<Record<string, unknown>> };
    expect(keys.data.length).toBeGreaterThan(0);
    expect(keys.data[0]).not.toHaveProperty("hashedKey");
    for (const [entity, column] of [["calendar_tokens", "tokenHash"], ["calendar_feeds", "urlEnc"], ["push_subscriptions", "keys"], ["files", "storageKey"]] as const) {
      const res = await data(`/api/v1/data/${entity}?${column}=x`, entity);
      expect(res.status, `${entity}.${column} is not filterable`).toBe(400);
    }
  });

  test("every table is either exported or excluded by name, so a new table cannot leak by default", () => {
    const tables = (Object.values(schema) as unknown[]).filter((t): t is PgTable => is(t, PgTable)).map((t) => getTableName(t));
    expect(exportCoverage(tables)).toEqual({ unlisted: [], unknown: [] });
    // A table added to the schema without a decision is reported.
    expect(exportCoverage([...tables, "new_secret_table"]).unlisted).toEqual(["new_secret_table"]);
    expect([...EXCLUDED_TABLES].sort(byText)).toEqual(["accounts", "auth_throttle", "invites", "sessions", "training_outbox", "two_factors", "verifications"]);
    expect(EXPORT_TABLES.filter((t) => EXCLUDED_TABLES.includes(t))).toEqual([]);
  });

  test("the export is a zip with one file per table and no password hashes or tokens", async () => {
    const tables = (Object.values(schema) as unknown[]).filter((t): t is PgTable => is(t, PgTable)).map((t) => getTableName(t));
    const secret = new Set(["sessions", "accounts", "verifications", "two_factors", "invites", "auth_throttle", "training_outbox"]);
    expect([...EXPORT_TABLES].sort(byText)).toEqual(tables.filter((t) => !secret.has(t)).sort(byText));
    for (const format of ["json", "csv"] as const) {
      const res = await call(exportGet, `/api/v1/export?format=${format}`, { headers: bearer(readKey) });
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("application/zip");
      const zip = unzip(Buffer.from(await res.arrayBuffer()));
      expect([...zip.keys()].filter((n) => n !== "files.txt").sort(byText)).toEqual(EXPORT_TABLES.map((t) => `${t}.${format}`).sort(byText));
      const all = [...zip.values()].join("\n");
      expect(all).toContain("Paged Vendor 0");
      expect(all).not.toContain("very-secret-password-hash");
      expect(all).not.toContain(adminSecretMarker);
      expect(all).not.toMatch(/hashed_?key|token_?hash|url_?enc/i);
      expect(zip.get("files.txt")).toMatch(/W-9 and other files are not included/);
    }
    expect((await call(exportGet, "/api/v1/export?format=xml", { headers: bearer(readKey) })).status).toBe(400);
  });

  test("personnel cannot read the data API or the export", async () => {
    const { db } = get();
    const deputy = await makeUser(db, "personnel", "data-deputy@example.test");
    const token = await sessionToken(db, deputy.row.id);
    expect((await call(dataGet, "/api/v1/data/vendors", { headers: bearer(token), params: { entity: "vendors" } })).status).toBe(403);
    expect((await call(exportGet, "/api/v1/export?format=json", { headers: bearer(token) })).status).toBe(403);
  });
});
