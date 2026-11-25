import type { z } from "zod";
import { runInMode, runnerFor, type DataMode, type TxRunner } from "@/db/client";
import type { Actor } from "@/domain/actor";
import { RateLimitedError, authenticateApiKey, type ApiKeyScope } from "@/domain/api-keys/api-keys";
import { getRequestContext } from "@/domain/auth/session";
import { contextForSession, type RequestContext } from "@/domain/training/mode";
import { DomainError, ForbiddenError, NotFoundError, RuleViolation, UnauthenticatedError, ValidationError } from "@/domain/errors";
import { sessions } from "@/db/schema";
import { and, eq, gt } from "drizzle-orm";
import type { RouteDef } from "./registry";

export type { DataMode, TxRunner } from "@/db/client";

export type Principal =
  | { kind: "session"; actor: Actor; mode: DataMode; context: RequestContext }
  | { kind: "apiKey"; actor: Actor; mode: "live"; key: { id: string; name: string; prefix: string; scopes: ApiKeyScope[] } };

const live = runnerFor("live");

/**
 * The one place an API request's data source is chosen, from the mode its session had when the request started.
 * API keys always use live data, never training mode, whatever else the request carries.
 */
export function getTx(principal: Principal | null): TxRunner {
  if (!principal || principal.kind === "apiKey") return live;
  return principal.context.run;
}

function sessionPrincipal(context: RequestContext): Principal {
  return { kind: "session", actor: context.actor, mode: context.mode, context };
}

const KEY_MARKER = "ed_live_";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** True for an id in a route path that cannot be a record id (so the answer is 404 without a query). */
export function isMalformedId(value: string): boolean {
  return !UUID.test(value);
}

/**
 * Who is calling: an API key (`Authorization: Bearer ed_live_...`), a session token sent as a bearer token (the
 * native app), or the session cookie. Null when there is none. A key that is not valid is an error, not anonymous.
 */
export async function authenticate(req: Request, path: string): Promise<Principal | null> {
  const header = req.headers.get("authorization") ?? "";
  const m = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (m) {
    const token = m[1];
    if (token.startsWith(KEY_MARKER)) {
      const { key, actor } = await live((tx) => authenticateApiKey(tx, token, { method: req.method, path }));
      return { kind: "apiKey", actor, mode: "live", key };
    }
    // A signed cookie value is `token.signature`; the token alone is the credential.
    const raw = token.split(".")[0];
    const s = await live(async (tx) => {
      const [row] = await tx.select({ id: sessions.id, userId: sessions.userId }).from(sessions).where(and(eq(sessions.token, raw), gt(sessions.expiresAt, new Date())));
      return row ?? null;
    });
    const context = s ? await contextForSession(s) : null;
    if (!context) throw new UnauthenticatedError("The session has ended. Sign in again.");
    return sessionPrincipal(context);
  }
  const context = await getRequestContext(req.headers);
  return context ? sessionPrincipal(context) : null;
}

const STATUS: Record<string, number> = {
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  validation: 400,
  rule_violation: 409,
  too_large: 413,
};

/** The Postgres error code behind a query error, if any (Drizzle wraps the driver's error in `cause`). */
function pgCode(e: unknown): string | null {
  for (let cur = e, i = 0; cur && i < 4; cur = (cur as { cause?: unknown }).cause, i++) {
    const code = (cur as { code?: unknown }).code;
    if (typeof code === "string" && /^[0-9A-Z]{5}$/.test(code)) return code;
  }
  return null;
}

/** A database refusal the caller caused, as a domain error; anything else is left alone (a 500). */
function fromDatabase(e: unknown): DomainError | null {
  switch (pgCode(e)) {
    case "23505":
      return new ValidationError("That is already in use. Choose a different value.");
    case "23503":
      return new ValidationError("A record this refers to does not exist.");
    case "23514":
    case "23502":
      return new ValidationError("A value is missing or not allowed.");
    case "22P02":
    case "22007":
    case "22008":
    case "22003":
      return new ValidationError("A value is not in the right format.");
    default:
      return null;
  }
}

function json(status: number, body: unknown, headers: HeadersInit = {}): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
}

/**
 * The response for a thrown error: domain errors map to their status (RuleViolation is 409 with its checks),
 * database refusals to 400, a rate-limited key to 429. With `hideForbidden` (file routes) a forbidden read answers
 * 404 so ids cannot be probed. Anything else is rethrown.
 */
export function errorResponse(e: unknown, opts: { hideForbidden?: boolean } = {}): Response {
  if (e instanceof RateLimitedError) return json(429, { error: { code: "rate_limited", message: e.message } }, { "retry-after": "60" });
  const err = e instanceof DomainError ? e : fromDatabase(e);
  if (!err) throw e;
  let status = STATUS[err.code] ?? 400;
  if (status === 403 && opts.hideForbidden && !(err instanceof KeyScopeError)) status = 404;
  if (status === 404) return json(404, { error: { code: "not_found", message: err instanceof NotFoundError ? err.message : "Not found." } });
  const body: { code: string; message: string; checks?: unknown; fields?: unknown } = { code: err.code, message: err.message };
  if (err instanceof RuleViolation) {
    body.checks = err.checks;
    if (err.fields) body.fields = err.fields;
  }
  return json(status, { error: body }, status === 401 ? { "www-authenticate": "Bearer" } : {});
}

function issueMessage(error: z.ZodError): string {
  const i = error.issues[0];
  return `${i.path.length > 0 ? `${i.path.join(".")}: ` : ""}${i.message}`;
}

function parse<T>(schema: z.ZodType<T> | undefined, raw: unknown): T {
  if (!schema) return undefined as T;
  const r = schema.safeParse(raw);
  if (!r.success) throw new ValidationError(issueMessage(r.error));
  return r.data;
}

type Out<S> = S extends z.ZodType ? z.output<S> : undefined;

export type HandlerContext<D extends RouteDef> = {
  req: Request;
  params: Record<string, string>;
  body: Out<D["body"]>;
  query: Out<D["query"]>;
  /** Null on public routes, which never read the caller. */
  actor: D extends { public: true } ? null : Actor;
  principal: D extends { public: true } ? null : Principal;
  /** Runs work in one transaction on this request's data source (see getTx). */
  run: TxRunner;
};

type RouteContext = { params: Promise<Record<string, string>> };

/** Which key scopes a route needs: reads (GET, or a read-only POST) need read or write, changes need write, W-9 files add w9. */
function requiredScopes(def: RouteDef): ApiKeyScope[] {
  const base: ApiKeyScope[] = def.method === "GET" || def.readOnly ? [] : ["write"];
  return def.w9 ? [...base, "w9"] : base;
}

/** A key without the scope a route needs. Always 403, even where other refusals read as not found. */
export class KeyScopeError extends ForbiddenError {}

function checkScopes(def: RouteDef, p: Principal): void {
  if (p.kind !== "apiKey") return;
  const has = new Set(p.key.scopes);
  if (!has.has("read") && !has.has("write")) throw new KeyScopeError("This API key has no read scope.");
  const missing = requiredScopes(def).filter((s) => !has.has(s));
  if (missing.length) throw new KeyScopeError(`This API key does not have the ${missing.join(" and ")} scope.`);
}

/**
 * The one handler every /api/v1 route uses. It authenticates (session cookie, a session token as a bearer token,
 * or an API key), checks the key's scopes, answers 404 for a malformed id in the path, validates the JSON body and
 * query with the route's Zod schemas, runs `fn` and maps errors (see errorResponse). `fn` returns the `data` of a
 * JSON answer, or a Response of its own (files). The schemas also build the OpenAPI document.
 */
export function apiHandler<D extends RouteDef>(def: D, fn: (ctx: HandlerContext<D>) => Promise<unknown>): (req: Request, ctx: RouteContext) => Promise<Response> {
  return async (req, routeCtx) => {
    try {
      const params = (await routeCtx?.params) ?? {};
      // Public routes need no one (and read no session), so a stale cookie or token never blocks them.
      const principal = def.public ? null : await authenticate(req, new URL(req.url).pathname);
      if (!principal && !def.public) throw new UnauthenticatedError();
      if (principal) checkScopes(def, principal);
      for (const [name, value] of Object.entries(params)) {
        if ((name === "id" || name.endsWith("Id")) && isMalformedId(value)) throw new NotFoundError();
      }
      const query = parse(def.query, Object.fromEntries(new URL(req.url).searchParams));
      let body: unknown;
      if (def.body) {
        const text = await req.text();
        let raw: unknown;
        try {
          raw = text === "" ? undefined : JSON.parse(text);
        } catch {
          throw new ValidationError("Send the details as JSON.");
        }
        body = parse(def.body, raw);
      }
      const ctx = { req, params, body, query, actor: principal?.actor ?? null, principal, run: getTx(principal) } as HandlerContext<D>;
      // The whole handler runs in the request's mode, so storage, PDFs and email outside `run` follow it too.
      const mode: DataMode = principal?.kind === "session" ? principal.mode : "live";
      const out = await runInMode(mode, () => fn(ctx));
      if (out instanceof Response) return out;
      return json(def.status ?? 200, { data: out ?? null });
    } catch (e) {
      return errorResponse(e, { hideForbidden: def.hideForbidden });
    }
  };
}
