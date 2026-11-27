import { openApiDocument } from "@/lib/api/openapi";
import { Card, CardTitle } from "@/ui/components/Card";
import { Icon } from "@/ui/icons";

const MONO = "[font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace]";

type Schema = { type?: string | string[]; properties?: Record<string, Schema>; required?: string[]; items?: Schema; enum?: unknown[]; anyOf?: Schema[]; description?: string; format?: string };
type Op = {
  summary: string;
  description?: string;
  tags: string[];
  security?: unknown[];
  "x-scopes"?: string[];
  parameters: Array<{ name: string; in: string; required: boolean; schema: Schema }>;
  requestBody?: { content: Record<string, { schema: Schema }> };
  responses: Record<string, { content?: Record<string, unknown> }>;
};

/** A short type for a field: "text", "number", "yes or no", "list", one of the enum values, or "object". */
function typeOf(s: Schema | undefined): string {
  if (!s) return "any";
  if (s.enum) return s.enum.map(String).join(" or ");
  if (s.anyOf) return [...new Set(s.anyOf.map(typeOf).filter((t) => t !== "null"))].join(" or ") || "any";
  const t = Array.isArray(s.type) ? s.type.filter((x) => x !== "null")[0] : s.type;
  if (s.format === "binary") return "file";
  switch (t) {
    case "string":
      return s.format === "date-time" ? "date or timestamp" : "text";
    case "integer":
      return "whole number";
    case "number":
      return "number";
    case "boolean":
      return "true or false";
    case "array":
      return `list of ${typeOf(s.items)}`;
    case "object":
      return "object";
    case "null":
      return "null";
    default:
      return "any";
  }
}

function access(op: Op): string {
  const scopes = op["x-scopes"] ?? [];
  if (scopes.length === 0) return "No sign-in";
  return `${scopes.join(" and ")} scope${scopes.length > 1 ? "s" : ""}`;
}

function Fields({ title, rows }: Readonly<{ title: string; rows: Array<{ name: string; type: string; required: boolean }> }>) {
  if (rows.length === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-semibold text-muted">{title}</span>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-sm">
        {rows.map((r) => (
          <li key={r.name} className="flex flex-wrap gap-x-2">
            <code className={`text-ink ${MONO}`}>{r.name}</code>
            <span className="text-muted">
              {r.type}
              {r.required ? "" : ", optional"}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Endpoint({ method, path, op }: Readonly<{ method: string; path: string; op: Op }>) {
  const query = op.parameters.filter((p) => p.in === "query").map((p) => ({ name: p.name, type: typeOf(p.schema), required: p.required }));
  const bodyType = op.requestBody ? Object.keys(op.requestBody.content)[0] : null;
  const body = bodyType ? op.requestBody!.content[bodyType].schema : null;
  const props = body?.properties ?? body?.anyOf?.find((s) => s.properties)?.properties ?? {};
  const required = body?.required ?? body?.anyOf?.find((s) => s.required)?.required ?? [];
  const bodyRows = Object.entries(props).map(([name, s]) => ({ name, type: typeOf(s), required: required.includes(name) }));
  const ok = Object.entries(op.responses).find(([code]) => code.startsWith("2"));
  const returns = ok?.[1].content && !ok[1].content["application/json"] ? `A file (${Object.keys(ok[1].content)[0]})` : "JSON: { data }";
  return (
    <li className="flex flex-col gap-2 px-4 py-3.5 md:px-5.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className={`inline-flex w-16 shrink-0 justify-center rounded-full bg-sunken px-2 py-0.75 text-xs font-semibold text-ink ${MONO}`}>{method.toUpperCase()}</span>
        <code className={`min-w-0 text-sm font-semibold break-all text-ink ${MONO}`}>{path}</code>
      </div>
      <p className="m-0">{op.summary}.</p>
      {op.description ? <p className="m-0 max-w-[70ch] text-sm text-muted">{op.description}</p> : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <Fields title="Query" rows={query} />
        <Fields title={bodyType === "multipart/form-data" ? "Form fields (multipart)" : "JSON body"} rows={bodyRows} />
      </div>
      <p className="m-0 text-xs text-muted">
        Needs {access(op)}. Returns {returns}.
      </p>
    </li>
  );
}

/** A readable view of /api/v1/openapi.json, grouped by area. Built on the server from the same document. */
export function ApiReference() {
  const doc = openApiDocument() as { paths: Record<string, Record<string, Op>> };
  const groups = new Map<string, Array<{ method: string; path: string; op: Op }>>();
  for (const [path, methods] of Object.entries(doc.paths)) {
    for (const [method, op] of Object.entries(methods)) {
      const tag = op.tags[0] ?? "API";
      groups.set(tag, [...(groups.get(tag) ?? []), { method, path, op }]);
    }
  }
  const total = [...groups.values()].reduce((n, g) => n + g.length, 0);
  return (
    <section aria-labelledby="reference-title" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <h2 id="reference-title" className="m-0 text-title font-semibold md:text-base">
          API reference
        </h2>
        <a href="/api/v1/openapi.json" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold" download="signal-90-openapi.json">
          Download the OpenAPI document
          <Icon name="download" size={16} />
        </a>
      </div>
      <Card>
        <CardTitle as="h3">How to call it</CardTitle>
        <ul className="m-0 flex max-w-[70ch] list-disc flex-col gap-1.5 pl-5 text-body">
          <li>
            Send the key on every request: <code className={MONO}>Authorization: Bearer ed_live_...</code>
          </li>
          <li>A read key may use GET. A read and write key may use every method, under the same rules and audit as the app. W-9 files also need the W-9 downloads permission.</li>
          <li>
            Success answers <code className={MONO}>{"{ data }"}</code>. A refusal answers <code className={MONO}>{"{ error: { code, message } }"}</code> with 400, 401, 403, 404, 409 (a rule, with <code className={MONO}>checks</code>), 413 or 429.
          </li>
          <li>Each key may make 600 requests a minute. Every request is logged with the key&apos;s name.</li>
          <li>Dates written as YYYY-MM-DD are days in agency time (America/Chicago).</li>
          <li>
            Every table: <code className={MONO}>GET /api/v1/data/&#123;table&#125;</code> with <code className={MONO}>updatedSince</code>, <code className={MONO}>cursor</code> and column filters. Everything at once:{" "}
            <code className={MONO}>GET /api/v1/export?format=json</code> or <code className={MONO}>csv</code>.
          </li>
        </ul>
      </Card>
      <p className="m-0 text-sm text-muted">{total} routes in {groups.size} areas.</p>
      <div className="flex flex-col gap-2.5">
        {[...groups.entries()].map(([tag, ops]) => (
          <details key={tag} className="group rounded-xl border border-line bg-surface md:rounded-2xl">
            <summary className="flex min-h-13 cursor-pointer list-none items-center justify-between gap-2 rounded-xl px-4 font-semibold md:rounded-2xl md:px-5.5 [&::-webkit-details-marker]:hidden">
              <span>
                {tag} <span className="font-normal text-muted">({ops.length})</span>
              </span>
              <Icon name="chevronDown" size={18} className="shrink-0 text-muted transition-transform duration-150 group-open:rotate-180" />
            </summary>
            <ul className="m-0 list-none divide-y divide-divider border-t border-divider p-0">
              {ops.map((o) => (
                <Endpoint key={`${o.method} ${o.path}`} {...o} />
              ))}
            </ul>
          </details>
        ))}
      </div>
    </section>
  );
}
