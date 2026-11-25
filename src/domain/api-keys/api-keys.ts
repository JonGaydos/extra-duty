import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, gt, isNull, or } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { apiKeys } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { loadActiveActor } from "../auth/sign-in-policy";
import { NotFoundError, UnauthenticatedError, ValidationError } from "../errors";

export const API_KEY_SCOPES = ["read", "write", "w9"] as const;
export type ApiKeyScope = (typeof API_KEY_SCOPES)[number];

/** Every key starts with this, so a key is easy to recognize (and to find if it leaks). */
export const API_KEY_PREFIX = "ed_live_";
/** Characters of the key kept in the clear to tell keys apart: the marker plus 6. */
const SHOWN = API_KEY_PREFIX.length + 6;
export const API_KEY_RATE_PER_MINUTE = 600;
const NAME_MAX = 100;

type Row = typeof apiKeys.$inferSelect;
/** A key as listed: never the hash. */
export type ApiKeyView = Omit<Row, "hashedKey">;

export type ApiKeyInput = { name: string; scopes: ApiKeyScope[]; expiresAt?: Date };

const hash = (key: string) => createHash("sha256").update(key).digest("hex");

function view(row: Row): ApiKeyView {
  const out: Partial<Row> = { ...row };
  delete out.hashedKey;
  return out as ApiKeyView;
}

/** What an audit row keeps of a key: name, prefix and scopes; never the key or its hash. */
const auditView = (row: Row) => ({ name: row.name, prefix: row.prefix, scopes: row.scopes, expiresAt: row.expiresAt, revokedAt: row.revokedAt });

/**
 * Admins only. The full key is returned once and only its SHA-256 hash is stored. `read` reads everything,
 * `write` reads and writes, and `w9` adds W-9 downloads (off unless chosen). The key acts as the admin who made it.
 */
export async function createApiKey(actor: Actor, tx: Tx, input: ApiKeyInput, now = new Date()): Promise<{ key: string; id: string; prefix: string }> {
  assertCan(actor, "apiKey.manage");
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (!name) throw new ValidationError("Name the key after the system that will use it.");
  if (name.length > NAME_MAX) throw new ValidationError(`Keep the name under ${NAME_MAX} characters.`);
  const scopes = [...new Set(Array.isArray(input.scopes) ? input.scopes : [])];
  if (scopes.some((s) => !(API_KEY_SCOPES as readonly string[]).includes(s))) throw new ValidationError("A scope must be read, write or w9.");
  if (!scopes.includes("read") && !scopes.includes("write")) throw new ValidationError("Choose read or read and write.");
  if (input.expiresAt !== undefined && !(input.expiresAt instanceof Date && input.expiresAt.getTime() > now.getTime())) {
    throw new ValidationError("The expiry date must be in the future.");
  }
  const key = `${API_KEY_PREFIX}${randomBytes(24).toString("base64url")}`;
  const ordered = API_KEY_SCOPES.filter((s) => scopes.includes(s));
  const [row] = await tx
    .insert(apiKeys)
    .values({ name, hashedKey: hash(key), prefix: key.slice(0, SHOWN), scopes: ordered, createdBy: actor.userId, expiresAt: input.expiresAt ?? null })
    .returning();
  await recordAudit(tx, { actor, action: "api_key.create", entityType: "api_key", entityId: row.id, after: auditView(row) });
  return { key, id: row.id, prefix: row.prefix };
}

/** Admins only. A revoked key stops working at once and stays listed for the record. */
export async function revokeApiKey(actor: Actor, tx: Tx, id: string, now = new Date()): Promise<ApiKeyView> {
  assertCan(actor, "apiKey.manage");
  const [before] = await tx.select().from(apiKeys).where(eq(apiKeys.id, id)).for("update");
  if (!before) throw new NotFoundError("API key not found.");
  if (before.revokedAt) return view(before);
  const [row] = await tx.update(apiKeys).set({ revokedAt: now }).where(eq(apiKeys.id, id)).returning();
  await recordAudit(tx, { actor, action: "api_key.revoke", entityType: "api_key", entityId: id, before: auditView(before), after: auditView(row) });
  return view(row);
}

/** Admins only. Newest first, revoked ones included. */
export async function listApiKeys(actor: Actor, tx: Tx): Promise<ApiKeyView[]> {
  assertCan(actor, "apiKey.manage");
  const rows = await tx.select().from(apiKeys).orderBy(desc(apiKeys.createdAt), desc(apiKeys.id));
  return rows.map(view);
}

/**
 * Admins only. The keys an admin made that still work (not revoked, not expired), oldest first, by name and prefix:
 * turning that admin off stops them, so the deactivation screen lists them.
 */
export async function activeApiKeysOf(actor: Actor, tx: Tx, userId: string, now = new Date()): Promise<Array<{ id: string; name: string; prefix: string }>> {
  assertCan(actor, "apiKey.manage");
  return tx
    .select({ id: apiKeys.id, name: apiKeys.name, prefix: apiKeys.prefix })
    .from(apiKeys)
    .where(and(eq(apiKeys.createdBy, userId), isNull(apiKeys.revokedAt), or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, now))))
    .orderBy(asc(apiKeys.createdAt), asc(apiKeys.id));
}

// One window per key in this process: at most API_KEY_RATE_PER_MINUTE requests in any 60 seconds.
const windows = new Map<string, number[]>();

/** Test hook. */
export function resetApiKeyLimits(): void {
  windows.clear();
}

/** Takes one request from the key's allowance; false when the key has used its 600 in the last minute. */
export function takeApiKeyRequest(keyId: string, now = Date.now()): boolean {
  const recent = (windows.get(keyId) ?? []).filter((t) => t > now - 60_000);
  if (recent.length >= API_KEY_RATE_PER_MINUTE) {
    windows.set(keyId, recent);
    return false;
  }
  recent.push(now);
  windows.set(keyId, recent);
  return true;
}

export type AuthenticatedKey = { key: { id: string; name: string; prefix: string; scopes: ApiKeyScope[] }; actor: Actor };

export class RateLimitedError extends Error {
  constructor() {
    super("This API key has made more than 600 requests in the last minute. Wait a minute and try again.");
  }
}

/**
 * The key behind a request, or UnauthenticatedError when it is unknown, revoked or expired, or its admin is no
 * longer active. Each use is rate-limited, stamps lastUsedAt and is audited with the key's name and prefix.
 */
export async function authenticateApiKey(tx: Tx, raw: string, request: { method: string; path: string }, now = new Date()): Promise<AuthenticatedKey> {
  const [row] = await tx.select().from(apiKeys).where(eq(apiKeys.hashedKey, hash(raw)));
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt.getTime() <= now.getTime())) {
    throw new UnauthenticatedError("The API key is not valid. It may have been revoked or expired.");
  }
  const actor = await loadActiveActor(tx, row.createdBy);
  if (!actor || actor.role !== "admin") throw new UnauthenticatedError("The admin who made this API key is no longer active.");
  if (!takeApiKeyRequest(row.id, now.getTime())) throw new RateLimitedError();
  await tx.update(apiKeys).set({ lastUsedAt: now }).where(eq(apiKeys.id, row.id));
  await recordAudit(tx, {
    actor,
    action: "api_key.request",
    entityType: "api_key",
    entityId: row.id,
    after: { name: row.name, prefix: row.prefix, method: request.method, path: request.path },
  });
  return { key: { id: row.id, name: row.name, prefix: row.prefix, scopes: row.scopes as ApiKeyScope[] }, actor };
}
