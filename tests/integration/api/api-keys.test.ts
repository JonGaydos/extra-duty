import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useApiDb, bearer, call } from "./helpers";
import { makeUser } from "../users/helpers";
import { apiKeys, auditLog, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { API_KEY_RATE_PER_MINUTE, activeApiKeysOf, createApiKey, listApiKeys, resetApiKeyLimits, revokeApiKey, takeApiKeyRequest } from "@/domain/api-keys/api-keys";
import { getTx, type Principal } from "@/lib/api/handler";
import { GET as dataGet } from "@/app/api/v1/data/[entity]/route";
import { POST as createVendor } from "@/app/api/v1/vendors/route";
import { POST as runReportRoute } from "@/app/api/v1/reports/run/route";
import { POST as exportReportRoute } from "@/app/api/v1/reports/export/route";
import { POST as runSavedRoute } from "@/app/api/v1/reports/saved/[id]/run/route";
import { POST as saveReportRoute } from "@/app/api/v1/reports/saved/route";
import { GET as myW9 } from "@/app/api/v1/me/w9/route";
import { GET as userW9 } from "@/app/api/v1/users/[id]/w9/route";

describe("API keys", () => {
  const get = useApiDb();
  let admin: Actor;
  let coordinator: Actor;
  let personnelId: string;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    admin = (await makeUser(db, "admin", "keys-admin@example.test")).actor;
    coordinator = (await makeUser(db, "coordinator", "keys-coord@example.test")).actor;
    personnelId = (await makeUser(db, "personnel", "keys-deputy@example.test")).row.id;
  });

  const make = (scopes: Array<"read" | "write" | "w9">, extra: { name?: string; expiresAt?: Date } = {}) =>
    get().db.transaction((tx) => createApiKey(admin, tx, { name: extra.name ?? `Key ${scopes.join("+")}`, scopes, expiresAt: extra.expiresAt }));

  test("a coordinator cannot create an API key; personnel cannot list them", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => createApiKey(coordinator, tx, { name: "Nope", scopes: ["read"] }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => listApiKeys(coordinator, tx))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("an admin's active keys, by name and prefix, for the deactivation warning; admins only", async () => {
    const { db } = get();
    const other = (await makeUser(db, "admin", "keys-other@example.test")).actor;
    const t0 = new Date();
    const live = await db.transaction((tx) => createApiKey(other, tx, { name: "Live sync", scopes: ["read"] }));
    const gone = await db.transaction((tx) => createApiKey(other, tx, { name: "Gone sync", scopes: ["read"] }));
    await db.transaction((tx) => revokeApiKey(other, tx, gone.id));
    const lapsing = await db.transaction((tx) => createApiKey(other, tx, { name: "Lapsing sync", scopes: ["read"], expiresAt: new Date(t0.getTime() + 60_000) }));
    await db.transaction((tx) => createApiKey(admin, tx, { name: "Not theirs", scopes: ["read"] }));
    const now = await db.transaction((tx) => activeApiKeysOf(admin, tx, other.userId, t0));
    expect(now).toEqual([
      { id: live.id, name: "Live sync", prefix: live.prefix },
      { id: lapsing.id, name: "Lapsing sync", prefix: lapsing.prefix },
    ]);
    const later = await db.transaction((tx) => activeApiKeysOf(admin, tx, other.userId, new Date(t0.getTime() + 120_000)));
    expect(later.map((k) => k.name)).toEqual(["Live sync"]);
    await expect(db.transaction((tx) => activeApiKeysOf(coordinator, tx, other.userId))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the key is shown once and stored only as a hash; the audit names the key, never the secret", async () => {
    const { db } = get();
    const { key, id } = await make(["read"], { name: "Payroll export" });
    expect(key).toMatch(/^ed_live_[A-Za-z0-9_-]{32,}$/);
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row.hashedKey).not.toContain(key);
    expect(JSON.stringify(row)).not.toContain(key.slice(8));
    expect(key.startsWith(row.prefix)).toBe(true);
    expect(row.scopes).toEqual(["read"]);
    const listed = await db.transaction((tx) => listApiKeys(admin, tx));
    expect(listed.find((k) => k.id === id)).toMatchObject({ name: "Payroll export", prefix: row.prefix, scopes: ["read"] });
    expect(JSON.stringify(listed)).not.toContain(row.hashedKey);
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "api_key"), eq(auditLog.entityId, id)));
    expect(audit.map((a) => a.action)).toEqual(["api_key.create"]);
    expect(JSON.stringify(audit)).not.toContain(key.slice(8));
    expect(JSON.stringify(audit)).not.toContain(row.hashedKey);
  });

  test("bad input is refused: no name, unknown or empty scopes, w9 alone, a past expiry", async () => {
    const { db } = get();
    const bad = [
      { name: " ", scopes: ["read"] },
      { name: "X", scopes: [] },
      { name: "X", scopes: ["admin"] },
      { name: "X", scopes: ["w9"] },
      { name: "X", scopes: ["read"], expiresAt: new Date(Date.now() - 1000) },
    ];
    for (const input of bad) {
      await expect(db.transaction((tx) => createApiKey(admin, tx, input as never)), JSON.stringify(input)).rejects.toBeInstanceOf(ValidationError);
    }
  });

  test("a read key can read data but gets 403 on a write route; every request is audited with the key name", async () => {
    const { db } = get();
    const { key, id } = await make(["read"], { name: "Reader" });
    const since = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
    const res = await call(dataGet, `/api/v1/data/invoices?updatedSince=${since}`, { headers: bearer(key), params: { entity: "invoices" } });
    expect(res.status).toBe(200);
    expect(Array.isArray((await res.json()).data)).toBe(true);
    const write = await call(createVendor, "/api/v1/vendors", { method: "POST", headers: { ...bearer(key), "content-type": "application/json" }, body: JSON.stringify({ name: "Via key" }) });
    expect(write.status).toBe(403);
    expect(await db.select().from(vendors).where(eq(vendors.name, "Via key"))).toHaveLength(0);
    const uses = await db.select().from(auditLog).where(and(eq(auditLog.action, "api_key.request"), eq(auditLog.entityId, id)));
    expect(uses).toHaveLength(2);
    expect(uses[0].after).toMatchObject({ name: "Reader", method: "GET", path: "/api/v1/data/invoices" });
    expect(JSON.stringify(uses)).not.toContain(key.slice(8));
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, id));
    expect(row.lastUsedAt).not.toBeNull();
  });

  test("a read key can run and export reports (reads sent as POST), but cannot save one", async () => {
    const { key } = await make(["read"], { name: "Report reader" });
    const spec = { dataset: "activity", from: "2035-01-01", to: "2035-12-31", filters: {}, groupBy: ["deputy"], measures: ["details_worked", "hours"] };
    const json = { ...bearer(key), "content-type": "application/json" };
    const ran = await call(runReportRoute, "/api/v1/reports/run", { method: "POST", headers: json, body: JSON.stringify({ spec }) });
    expect(ran.status, await ran.clone().text()).toBe(200);
    const csv = await call(exportReportRoute, "/api/v1/reports/export", { method: "POST", headers: json, body: JSON.stringify({ spec, format: "csv" }) });
    expect(csv.status).toBe(200);
    const saved = await call(saveReportRoute, "/api/v1/reports/saved", { method: "POST", headers: json, body: JSON.stringify({ name: "Nope", spec }) });
    expect(saved.status).toBe(403);
    // A read-only POST still needs a real report: an unknown id is 404, not a scope refusal.
    const missing = "0190a7a4-0000-7000-8000-0000000000aa";
    expect((await call(runSavedRoute, `/api/v1/reports/saved/${missing}/run`, { method: "POST", headers: json, body: "{}", params: { id: missing } })).status).toBe(404);
  });

  test("a write key goes through the same domain services, so rules and audit apply", async () => {
    const { db } = get();
    const { key } = await make(["write"]);
    const ok = await call(createVendor, "/api/v1/vendors", { method: "POST", headers: { ...bearer(key), "content-type": "application/json" }, body: JSON.stringify({ name: "Key Vendor" }) });
    expect(ok.status).toBe(201);
    const [v] = await db.select().from(vendors).where(eq(vendors.name, "Key Vendor"));
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityType, "vendor"), eq(auditLog.entityId, v.id)));
    expect(audit.actorUserId).toBe(admin.userId);
    const refused = await call(createVendor, "/api/v1/vendors", { method: "POST", headers: { ...bearer(key), "content-type": "application/json" }, body: JSON.stringify({ name: " " }) });
    expect(refused.status).toBe(400);
  });

  test("a revoked or expired key gets 401; so does an unknown one", async () => {
    const { db } = get();
    const { key, id } = await make(["read"]);
    await db.transaction((tx) => revokeApiKey(admin, tx, id));
    expect((await call(dataGet, "/api/v1/data/vendors", { headers: bearer(key), params: { entity: "vendors" } })).status).toBe(401);
    const revokeAudit = await db.select().from(auditLog).where(and(eq(auditLog.action, "api_key.revoke"), eq(auditLog.entityId, id)));
    expect(revokeAudit).toHaveLength(1);
    const soon = await make(["read"], { expiresAt: new Date(Date.now() + 60_000) });
    await db.update(apiKeys).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(apiKeys.id, soon.id));
    expect((await call(dataGet, "/api/v1/data/vendors", { headers: bearer(soon.key), params: { entity: "vendors" } })).status).toBe(401);
    expect((await call(dataGet, "/api/v1/data/vendors", { headers: bearer("ed_live_unknownunknownunknownunknown00"), params: { entity: "vendors" } })).status).toBe(401);
  });

  test("a key without w9 gets 403 on W-9 downloads; with w9 it reaches the W-9 rules", async () => {
    const plain = await make(["read", "write"]);
    expect((await call(myW9, "/api/v1/me/w9", { headers: bearer(plain.key) })).status).toBe(403);
    expect((await call(userW9, `/api/v1/users/${personnelId}/w9`, { headers: bearer(plain.key), params: { id: personnelId } })).status).toBe(403);
    const w9 = await make(["read", "w9"]);
    // No W-9 is on file, so the request gets past the scope check to the W-9 service.
    expect((await call(userW9, `/api/v1/users/${personnelId}/w9`, { headers: bearer(w9.key), params: { id: personnelId } })).status).toBe(404);
  });

  test("a key is limited to 600 requests a minute", async () => {
    resetApiKeyLimits();
    const t = Date.UTC(2026, 0, 1);
    for (let i = 0; i < API_KEY_RATE_PER_MINUTE; i++) expect(takeApiKeyRequest("k1", t + i)).toBe(true);
    expect(takeApiKeyRequest("k1", t + 1000)).toBe(false);
    expect(takeApiKeyRequest("k2", t + 1000)).toBe(true);
    expect(takeApiKeyRequest("k1", t + 60_001)).toBe(true);
    expect(API_KEY_RATE_PER_MINUTE).toBe(600);
  });

  test("API keys always read and write live data, never training mode", async () => {
    const live = getTx(null);
    const viaKey = getTx({ kind: "apiKey", actor: admin, mode: "training", key: { id: "k", name: "K", prefix: "ed_live_x", scopes: ["read"] } } as unknown as Principal);
    expect(viaKey).toBe(live);
    expect(await viaKey(async (tx) => (await tx.execute("select 1 as one")).rows[0])).toEqual({ one: 1 });
  });
});
