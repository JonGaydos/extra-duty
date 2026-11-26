import { z } from "zod";
import { allRoutes, fileType, type RouteDef } from "./registry";

type Json = Record<string, unknown>;

function schemaOf(s: z.ZodType, io: "input" | "output"): Json {
  const out = z.toJSONSchema(s, { io, unrepresentable: "any", target: "draft-2020-12" }) as Json;
  delete out.$schema;
  return out;
}

const ERROR: Json = {
  type: "object",
  properties: {
    error: {
      type: "object",
      properties: {
        code: { type: "string" },
        message: { type: "string" },
        checks: { type: "array", items: { type: "object", properties: { check: { type: "string" }, ok: { type: "boolean" }, message: { type: "string" } } } },
      },
      required: ["code", "message"],
    },
  },
};

const ERRORS: Record<string, string> = {
  "400": "The input is not valid.",
  "401": "No valid session or API key.",
  "403": "Not allowed, or the API key lacks a scope.",
  "404": "Not found.",
  "409": "A business rule refused it; `checks` lists each rule.",
  "413": "The upload is too large.",
  "429": "The API key made more than 600 requests in the last minute.",
};

function queryParameters(def: RouteDef): Json[] {
  if (!def.query) return [];
  const js = schemaOf(def.query, "input") as { properties?: Record<string, Json>; required?: string[] };
  return Object.entries(js.properties ?? {}).map(([name, schema]) => ({ name, in: "query", required: js.required?.includes(name) ?? false, schema }));
}

function operation(def: RouteDef): Json {
  const params = [...def.path.matchAll(/\{(\w+)\}/g)].map((m) => ({ name: m[1], in: "path", required: true, schema: { type: "string" } }));
  const op: Json = {
    operationId: `${def.method.toLowerCase()}${def.path.replace(/[{}.]/g, "").replace(/(?:^|[/-])(\w)/g, (_, c: string) => c.toUpperCase())}`,
    summary: def.summary,
    tags: [def.tag ?? "API"],
    parameters: [...params, ...queryParameters(def)],
  };
  if (def.description) op.description = def.description;
  // The API key scopes this route needs (none on public routes).
  op["x-scopes"] = def.public ? [] : [def.method === "GET" || def.readOnly ? "read" : "write", ...(def.w9 ? ["w9"] : [])];
  if (def.public) op.security = [];
  if (def.w9) op.description = def.description ? `${def.description} API keys need the w9 scope.` : "API keys need the w9 scope.";
  if (def.body) op.requestBody = { required: true, content: { "application/json": { schema: schemaOf(def.body, "input") } } };
  if (def.form) {
    op.requestBody = {
      required: true,
      content: {
        "multipart/form-data": {
          schema: { type: "object", properties: Object.fromEntries(Object.entries(def.form).map(([k, d]) => [k, { type: "string", description: d }])) },
        },
      },
    };
  }
  const type = fileType(def.response);
  const ok = type
    ? { description: "A file.", content: { [type]: { schema: { type: "string", format: "binary" } } } }
    : { description: "OK", content: { "application/json": { schema: { type: "object", properties: { data: schemaOf(def.response, "output") }, required: ["data"] } } } };
  op.responses = {
    [String(def.status ?? 200)]: ok,
    ...Object.fromEntries(Object.entries(ERRORS).map(([code, description]) => [code, { description, content: { "application/json": { schema: { $ref: "#/components/schemas/Error" } } } }])),
  };
  return op;
}

/** The OpenAPI 3.1 document for every /api/v1 route, built from the registry. */
export function openApiDocument(): Json {
  const paths: Record<string, Json> = {};
  for (const def of allRoutes()) {
    const p = `/api/v1${def.path}`;
    paths[p] = { ...(paths[p] ?? {}), [def.method.toLowerCase()]: operation(def) };
  }
  return {
    openapi: "3.1.0",
    info: {
      title: "Extra Duty API",
      version: "1",
      description:
        "The REST API behind the Extra Duty app. Authenticate with an API key (`Authorization: Bearer ed_live_...`, made by an admin), a session token as a bearer token, or the session cookie. Read scope allows GET; write scope allows every method and follows the same rules and audit as the app; w9 scope adds W-9 downloads. Answers are `{ data }` on success and `{ error: { code, message } }` on failure. Date-only inputs (YYYY-MM-DD) are agency days in America/Chicago.",
    },
    servers: [{ url: "/" }],
    security: [{ bearer: [] }, { cookie: [] }],
    components: {
      securitySchemes: {
        bearer: { type: "http", scheme: "bearer", description: "An API key (ed_live_...) or a session token." },
        cookie: { type: "apiKey", in: "cookie", name: "better-auth.session_token" },
      },
      schemas: { Error: ERROR },
    },
    paths,
  };
}
