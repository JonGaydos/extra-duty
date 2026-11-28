import { createHash } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Tx, TxRunner } from "@/db/client";
import { auditLog, auditRecords, users } from "@/db/schema";
import { csvCell } from "@/lib/csv";
import { renderAuditRecordPdf } from "@/lib/pdf/audit-record-pdf";
import type { Actor } from "../actor";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { loadAgencyHeader } from "../invoices/invoices";
import { agencyStamp } from "../time/agency-time";
import { recordAudit } from "./audit";
import { LARGE_PRINT } from "./labels";
import { assertMayReadAudit, auditOrder, auditWhere, changesText, countAudit, describeAudit, describeAuditQuery, roleLabel, type AuditEntryView, type AuditQuery, type AuditRow } from "./search";

/**
 * Exports and prints of the audit log (owner decision 2026-11-27). Whoever can read the log can export it as CSV or print
 * a formal Audit Record PDF of the matching entries, or of the ones they picked. Every export and print is audited with
 * who, the filters in plain words and the number of entries. A print is kept as a record with an ID and a SHA-256
 * integrity code over the canonical entry data, so an admin can later check a printed copy against the system.
 */

/** What to export: every entry matching the query, or only the chosen entries (still in the query's order). */
export type AuditSelection = { query: AuditQuery; ids?: string[] };

export { LARGE_PRINT };
/** The most a single print may hold. */
export const MAX_PRINT = 10_000;
const BATCH = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** "AR-000012". */
export const formatRecordId = (n: number) => `AR-${String(n).padStart(6, "0")}`;

/** The number in "AR-000012", "ar 12" or "12"; null when it is not a record ID. */
export function parseRecordId(text: string): number | null {
  const m = /^\s*(?:AR[-\s]?)?0*(\d{1,9})\s*$/i.exec(text ?? "");
  return m ? Number(m[1]) : null;
}

/** JSON with object keys sorted at every level, so the same data always gives the same text. */
export function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      // Keys of one object are distinct, so this order is total and does not depend on the locale.
      .sort(([a], [b]) => (a < b ? -1 : 1));
    const pair = ([k, v]: [string, unknown]) => JSON.stringify(k) + ":" + canonicalJson(v);
    return `{${entries.map(pair).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** The entry fields the integrity code covers: everything the log stores about the action. */
export function canonicalEntry(r: Pick<AuditRow, "id" | "at" | "actorUserId" | "action" | "entityType" | "entityId" | "before" | "after" | "reason">): unknown {
  return { id: r.id, at: r.at.toISOString(), actorUserId: r.actorUserId, action: r.action, entityType: r.entityType, entityId: r.entityId, before: r.before, after: r.after, reason: r.reason };
}

/** SHA-256 (hex) of the canonical entries, in record order. */
export function integrityCode(rows: Array<Parameters<typeof canonicalEntry>[0]>): string {
  return createHash("sha256").update(canonicalJson(rows.map(canonicalEntry))).digest("hex");
}

/** The integrity code in groups of 8, as printed: easier to read aloud and compare. */
export const groupedCode = (hex: string) => hex.match(/.{1,8}/g)?.join(" ") ?? hex;

function checkIds(ids: unknown): string[] | undefined {
  if (ids === undefined) return undefined;
  if (!Array.isArray(ids) || ids.length === 0 || !ids.every((i) => typeof i === "string" && UUID.test(i))) throw new ValidationError("Choose the entries to export.");
  return [...new Set(ids as string[])];
}

async function selectionWhere(tx: Tx, sel: AuditSelection, now: Date) {
  const ids = checkIds(sel.ids);
  return ids ? inArray(auditLog.id, ids) : auditWhere(tx, sel.query, now);
}

/** How many entries the selection holds. */
export async function countSelection(actor: Actor, tx: Tx, sel: AuditSelection, now: Date = new Date()): Promise<number> {
  assertMayReadAudit(actor);
  return countAudit(tx, await selectionWhere(tx, sel, now));
}

async function loadRows(tx: Tx, sel: AuditSelection, now: Date, offset: number, limit: number): Promise<AuditRow[]> {
  return tx
    .select()
    .from(auditLog)
    .where(await selectionWhere(tx, sel, now))
    .orderBy(...auditOrder(sel.query))
    .limit(limit)
    .offset(offset);
}

async function actorLine(tx: Tx, actor: Actor): Promise<string> {
  const [u] = await tx.select({ name: users.name }).from(users).where(eq(users.id, actor.userId));
  return `${u?.name ?? "Unknown"} (${roleLabel(actor.role)})`;
}

export const CSV_HEADER = [
  "Entry ID",
  "Time",
  "Done by",
  "Role",
  "Action",
  "Action type",
  "About",
  "Detail",
  "Vendor",
  "Invoice",
  "Reason",
  "Changes",
  "IP address",
  "System or person",
];

/** One CSV row: agency time with the zone written out, plain words, readable changes, secrets left out. */
export function auditCsvRow(e: AuditEntryView): string[] {
  return [
    e.id,
    agencyStamp(e.at),
    e.actorName ?? "System",
    e.actorRole ?? "",
    e.label,
    e.groupLabel,
    e.subject,
    e.detailNumber === null ? "" : `#${e.detailNumber}`,
    e.vendorName ?? "",
    e.invoiceNumber ?? "",
    e.reason ?? "",
    changesText(e.changes),
    e.ipAddress ?? "",
    e.system ? "System" : "Person",
  ];
}

const csvLine = (cells: string[]) => `${cells.map(csvCell).join(",")}\r\n`;

/**
 * The CSV of the selection, streamed in batches (each its own read), after the export is audited. The formula guard
 * applies to every cell.
 */
export async function exportAuditCsv(actor: Actor, run: TxRunner, sel: AuditSelection, now: Date = new Date()): Promise<{ stream: ReadableStream<Uint8Array>; count: number }> {
  const count = await run(async (tx) => {
    assertMayReadAudit(actor);
    const n = await countAudit(tx, await selectionWhere(tx, sel, now));
    await recordAudit(tx, { actor, action: "audit.export", entityType: "audit_log", entityId: "csv", after: { format: "csv", filters: await describeAuditQuery(tx, sel.query, now), selected: sel.ids ? "chosen entries" : "all matching", entries: n } });
    return n;
  });
  const encoder = new TextEncoder();
  let offset = 0;
  let headerSent = false;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!headerSent) {
        headerSent = true;
        controller.enqueue(encoder.encode(csvLine(CSV_HEADER)));
        return;
      }
      const rows = await run(async (tx) => describeAudit(tx, await loadRows(tx, sel, now, offset, BATCH)));
      offset += rows.length;
      if (rows.length) controller.enqueue(encoder.encode(rows.map((r) => csvLine(auditCsvRow(r))).join("")));
      if (rows.length < BATCH) controller.close();
    },
  });
  return { stream, count };
}

/** The "System context" line of a printed entry. */
function contextLine(e: AuditEntryView): string {
  const parts = [e.ipAddress ? `IP address ${e.ipAddress}` : null, e.device ? `Device ${e.device}` : null].filter(Boolean);
  if (parts.length) return parts.join(". ");
  return e.system ? "Recorded by the system. No IP address or device recorded." : "No IP address or device recorded.";
}

/** "Robin Castillo (Coordinator)", or System. */
export function whoText(e: Pick<AuditEntryView, "system" | "actorName" | "actorRole">): string {
  if (e.system) return "System";
  const name = e.actorName ?? "Unknown";
  return e.actorRole ? `${name} (${e.actorRole})` : name;
}

export type PrintResult = { pdf: Buffer; recordId: string; integrity: string; count: number };

/**
 * Prints the selection as an Audit Record PDF and keeps the record (its entry IDs and integrity code) for checking
 * later. Over LARGE_PRINT entries it needs `confirmLarge`; over MAX_PRINT it is refused. The print is audited.
 */
export async function printAuditRecord(actor: Actor, tx: Tx, sel: AuditSelection, opts: { confirmLarge?: boolean; now?: Date } = {}): Promise<PrintResult> {
  const now = opts.now ?? new Date();
  assertMayReadAudit(actor);
  const count = await countAudit(tx, await selectionWhere(tx, sel, now));
  if (count === 0) throw new ValidationError("No entries match, so there is nothing to print.");
  if (count > MAX_PRINT) throw new ValidationError(`This record would have ${count.toLocaleString("en-US")} entries. Narrow the filters to ${MAX_PRINT.toLocaleString("en-US")} or fewer to print it.`);
  if (count > LARGE_PRINT && !opts.confirmLarge) {
    throw new ValidationError(`This record would have ${count.toLocaleString("en-US")} entries. Narrow the filters, or confirm to print all of them.`);
  }
  const rows: AuditRow[] = [];
  // Sequential: batches share the transaction's one connection.
  for (let offset = 0; offset < count; offset += BATCH) rows.push(...(await loadRows(tx, sel, now, offset, BATCH)));
  const integrity = integrityCode(rows);
  const filters = sel.ids ? [...(await describeAuditQuery(tx, sel.query, now)), `Chosen entries: ${rows.length}`] : await describeAuditQuery(tx, sel.query, now);
  const [rec] = await tx
    .insert(auditRecords)
    .values({ createdBy: actor.userId, filters, query: sel.query, entryIds: rows.map((r) => r.id), entryCount: rows.length, integrity, createdAt: now })
    .returning();
  const recordId = formatRecordId(rec.number);
  await recordAudit(tx, { actor, action: "audit.print", entityType: "audit_record", entityId: rec.id, after: { format: "pdf", record: recordId, filters, entries: rows.length, integrity } });
  const views = await describeAudit(tx, rows);
  const pdf = await renderAuditRecordPdf({
    agency: await loadAgencyHeader(tx),
    recordId,
    integrity,
    filters,
    generatedBy: await actorLine(tx, actor),
    generatedAt: agencyStamp(now),
    entries: views.map((e) => ({
      id: e.id,
      when: agencyStamp(e.at),
      who: whoText(e),
      action: e.label,
      subject: e.subject,
      reason: e.reason,
      changes: e.changes,
      context: contextLine(e),
    })),
  });
  return { pdf, recordId, integrity, count: rows.length };
}

export type Verification = {
  recordId: string;
  createdAt: Date;
  createdBy: string;
  filters: string[];
  entryCount: number;
  /** The code printed on the record. */
  integrity: string;
  /** The code of the entries as they are now. */
  current: string;
  /** The entries as they are now match the record. */
  matches: boolean;
  /** When a code was pasted from the printed copy: whether it is this record's code. */
  printedMatches: boolean | null;
  missing: number;
};

/** Admins: does a printed record still match the audit data? Takes the record ID and, optionally, the printed code. */
export async function verifyAuditRecord(actor: Actor, tx: Tx, input: { recordId: string; integrity?: string | null }): Promise<Verification> {
  if (actor.role !== "admin") throw new ForbiddenError("Only admins can verify an audit record.");
  const n = parseRecordId(input.recordId);
  if (n === null) throw new ValidationError("Enter the record ID printed on the record, such as AR-000012.");
  const [rec] = await tx.select().from(auditRecords).where(eq(auditRecords.number, n));
  if (!rec) throw new NotFoundError(`No audit record ${formatRecordId(n)}.`);
  const found = rec.entryIds.length ? await tx.select().from(auditLog).where(inArray(auditLog.id, rec.entryIds)) : [];
  const byId = new Map(found.map((r) => [r.id, r]));
  const ordered = rec.entryIds.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
  const current = integrityCode(ordered);
  const printed = input.integrity?.replace(/\s+/g, "").toLowerCase() || null;
  const [by] = await tx.select({ name: users.name }).from(users).where(eq(users.id, rec.createdBy));
  const matches = current === rec.integrity && ordered.length === rec.entryIds.length;
  await recordAudit(tx, { actor, action: "audit.verify", entityType: "audit_record", entityId: rec.id, after: { record: formatRecordId(rec.number), matches, printedMatches: printed === null ? null : printed === rec.integrity } });
  return {
    recordId: formatRecordId(rec.number),
    createdAt: rec.createdAt,
    createdBy: by?.name ?? "Unknown",
    filters: rec.filters,
    entryCount: rec.entryCount,
    integrity: rec.integrity,
    current,
    matches,
    printedMatches: printed === null ? null : printed === rec.integrity,
    missing: rec.entryIds.length - ordered.length,
  };
}
