import { and, asc, getTableColumns, getTableName, gt, gte, is, sql, type SQL } from "drizzle-orm";
import { PgTable, type PgColumn } from "drizzle-orm/pg-core";
import type { Tx } from "@/db/client";
import * as schema from "@/db/schema";
import { csvCell } from "@/lib/csv";
import type { Actor } from "../actor";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";
import { byText } from "@/lib/sort";

/**
 * Every table the data API and the export cover, by database name. A new table is covered only once it is added here
 * (or to EXCLUDED_TABLES); a test fails while any schema table is in neither list.
 */
const EXPORTED = [
  "access_review_items",
  "access_reviews",
  "api_keys",
  "assignments",
  "audit_log",
  "billing_lock_overrides",
  "calendar_busy",
  "calendar_feeds",
  "calendar_tokens",
  "deputy_notes",
  "earnings_goals",
  "files",
  "hidden_vendors",
  "invoice_batches",
  "invoice_events",
  "invoices",
  "job_attachments",
  "job_change_requests",
  "job_positions",
  "job_safety",
  "job_safety_addresses",
  "job_series",
  "job_types",
  "job_watches",
  "jobs",
  "message_recipients",
  "messages",
  "note_presets",
  "notification_prefs",
  "notifications",
  "ops_plan_alerts",
  "ops_plan_versions",
  "ops_plans",
  "payment_issue_notes",
  "payment_issues",
  "payment_methods",
  "position_types",
  "push_subscriptions",
  "qualification_requests",
  "qualifications",
  "quiet_hours",
  "ranks",
  "saved_reports",
  "schedule_exceptions",
  "seasons",
  "settings",
  "spot_offers",
  "user_qualifications",
  "users",
  "vendor_contacts",
  "vendor_documents",
  "vendor_holds",
  "vendor_locations",
  "vendor_managers",
  "vendor_restrictions",
  "vendor_types",
  "vendor_users",
  "vendors",
  "w9_request_people",
  "w9_requests",
  "w9s",
  "work_schedules",
] as const;

/**
 * Sign-in secrets: never an entity and never exported. The outbox (training and staging) holds the text of unsent
 * email, which includes invite and password reset links, so it is excluded with them.
 */
export const EXCLUDED_TABLES: readonly string[] = ["accounts", "auth_throttle", "invites", "sessions", "training_outbox", "two_factors", "verifications"];

/** Tables in `names` that are in neither list, and listed names that are not tables. Both must be empty. */
export function exportCoverage(names: readonly string[]): { unlisted: string[]; unknown: string[] } {
  const listed = new Set<string>([...EXPORTED, ...EXCLUDED_TABLES]);
  const have = new Set(names);
  return { unlisted: names.filter((n) => !listed.has(n)), unknown: [...listed].filter((n) => !have.has(n)) };
}

/**
 * Columns that are credentials or keys to other systems, by table and property name. They are never returned,
 * exported or filterable. (W-9 and other files are stored encrypted or behind the API; the storage key is internal.)
 */
const HIDDEN_COLUMNS: Record<string, readonly string[]> = {
  api_keys: ["hashedKey"],
  calendar_tokens: ["tokenHash"],
  calendar_feeds: ["urlEnc"],
  push_subscriptions: ["endpoint", "keys"],
  files: ["storageKey"],
};

/** JSON keys that hold secrets: any key containing one of the words, or ending in "enc" (settings keep the SMTP password and email API key encrypted). */
const isSecretKey = (key: string) => /password|secret|token|apikey/i.test(key) || /enc$/i.test(key);

type Entity = { name: string; table: PgTable; columns: Record<string, PgColumn> };

const ENTITIES: Map<string, Entity> = new Map(
  (Object.values(schema) as unknown[])
    .filter((t): t is PgTable => is(t, PgTable))
    .map((table) => ({ name: getTableName(table), table }))
    .filter((t) => (EXPORTED as readonly string[]).includes(t.name))
    .map(({ name, table }) => {
      const hidden = new Set(HIDDEN_COLUMNS[name] ?? []);
      const columns = Object.fromEntries(Object.entries(getTableColumns(table)).filter(([k]) => !hidden.has(k))) as Record<string, PgColumn>;
      return [name, { name, table, columns }] as const;
    }),
);

/** Every table in the data API and the export, by its database name. */
export const EXPORT_TABLES: readonly string[] = [...ENTITIES.keys()].sort(byText);

/** Hides non-empty text under secret-looking keys, at any depth. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isSecretKey(k) && typeof v === "string" && v !== "" ? "[hidden]" : redact(v)]));
  }
  return value;
}

function entity(name: string): Entity {
  const e = ENTITIES.get(name);
  if (!e) throw new NotFoundError("No such entity.");
  return e;
}

/** The column `updatedSince` compares: updated_at, else created_at, else the row's own time (the audit log's `at`). */
function changedColumn(e: Entity): PgColumn | null {
  return e.columns.updatedAt ?? e.columns.createdAt ?? e.columns.at ?? null;
}

async function page(tx: Tx, e: Entity, conds: SQL[], after: string | undefined, limit: number): Promise<Record<string, unknown>[]> {
  const id = e.columns.id;
  const where = and(...conds, ...(after ? [gt(id, after)] : []));
  const rows = (await tx.select(e.columns).from(e.table).where(where).orderBy(asc(id)).limit(limit)) as Record<string, unknown>[];
  return rows.map((r) => redact(r) as Record<string, unknown>);
}

export type EntityQuery = { updatedSince?: Date; cursor?: string; limit?: number; filters?: Record<string, string> };
const ENTITY_PAGE_DEFAULT = 100;

/**
 * Admins (and their API keys) only. One page of a table's rows in id order, without secret columns. `filters` are
 * equality tests on columns by property name, compared as text. `nextCursor` is the last id, or null at the end.
 */
export async function readEntity(actor: Actor, tx: Tx, name: string, q: EntityQuery = {}): Promise<{ rows: Record<string, unknown>[]; nextCursor: string | null }> {
  assertCan(actor, "data.readAll");
  const e = entity(name);
  const limit = q.limit ?? ENTITY_PAGE_DEFAULT;
  const conds: SQL[] = [];
  if (q.updatedSince) {
    const col = changedColumn(e);
    if (!col) throw new ValidationError(`${name} has no change time, so updatedSince does not apply.`);
    conds.push(gte(col, q.updatedSince));
  }
  for (const [key, value] of Object.entries(q.filters ?? {})) {
    const col = e.columns[key];
    if (!col) throw new ValidationError(`${key} is not a column of ${name}.`);
    conds.push(sql`${col}::text = ${value}`);
  }
  const rows = await page(tx, e, conds, q.cursor, limit);
  return { rows, nextCursor: rows.length === limit ? String(rows.at(-1)!.id) : null };
}

const EXPORT_PAGE = 1000;

function csvValue(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string") return csvCell(v);
  if (typeof v === "bigint") return csvCell(String(v));
  // Objects (JSON columns) as JSON; nothing else comes from the database.
  return csvCell(JSON.stringify(v) ?? "");
}

/**
 * Every exported table as text, one file at a time: `[name, chunks]`. JSON files are arrays of rows; CSV files
 * have a header of database column names. Rows are read in pages of 1,000 inside the caller's transaction.
 * Each file's chunks do the database reads, as the zip writer reaches that file.
 */
export function* exportTables(actor: Actor, tx: Tx, format: "json" | "csv"): Generator<{ name: string; chunks: AsyncIterable<string> | Iterable<string> }> {
  assertCan(actor, "data.readAll");
  for (const name of EXPORT_TABLES) {
    const e = entity(name);
    async function* chunks(): AsyncGenerator<string> {
      const keys = Object.keys(e.columns);
      if (format === "csv") yield keys.map((k) => e.columns[k].name).join(",") + "\r\n";
      else yield "[";
      let after: string | undefined;
      let first = true;
      // Sequential: each page starts after the last id of the one before.
      for (;;) {
        const rows = await page(tx, e, [], after, EXPORT_PAGE);
        if (rows.length === 0) break;
        const text =
          format === "csv"
            ? rows.map((r) => keys.map((k) => csvValue(r[k])).join(",") + "\r\n").join("")
            : rows.map((r, i) => `${first && i === 0 ? "" : ","}\n${JSON.stringify(r)}`).join("");
        first = false;
        yield text;
        after = String(rows.at(-1)!.id);
        if (rows.length < EXPORT_PAGE) break;
      }
      if (format === "json") yield "\n]\n";
    }
    yield { name: `${name}.${format}`, chunks: chunks() };
  }
  yield {
    name: "files.txt",
    chunks: [
      "W-9 and other files are not included. Each file is listed by id in the files table (name, type, size, kind, owner).\r\n",
      "Download one through the API: vendor documents, detail attachments, ops plans and invoices have their own routes; W-9s need an API key with the w9 scope.\r\n",
    ],
  };
}
