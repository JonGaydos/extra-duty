import { and, asc, desc, eq, gte, ilike, inArray, isNotNull, lte, or, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, auditLog, billingLockOverrides, invoices, jobs, paymentIssues, users, vendors, w9s } from "@/db/schema";
import type { Actor } from "../actor";
import { assertCan } from "../auth/policy";
import { ForbiddenError } from "../errors";
import { formatInvoiceNumber } from "../invoices/invoices";
import { getSettings } from "../settings/settings";
import { agencyDateOnly, agencyDayKey, agencyDateParts, agencyInstant } from "../time/agency-time";
import { AUDIT_GROUPS, auditGroup, auditLabel, DATE_PRESETS, isAuditGroup, type AuditGroup, type AuditQuery, type DatePreset } from "./labels";

/**
 * The audit log's filters (owner decision 2026-11-27): who did it, who it is about, the action type in plain-word
 * groups, a detail, vendor or invoice, a date range in agency time with presets, text in the reason and summary, and
 * whether system actions show. Results page newest first, or oldest first.
 */

export const AUDIT_PAGE_SIZE = 50;

export { DATE_PRESETS, type AuditQuery, type DatePreset } from "./labels";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function str(v: unknown): string {
  const first = Array.isArray(v) ? v[0] : v;
  return typeof first === "string" ? first.trim() : "";
}
const list = (v: unknown): string[] => (Array.isArray(v) ? v : [v]).flatMap((x) => (typeof x === "string" ? x.split(",") : [])).map((x) => x.trim()).filter(Boolean);
const whole = (v: string) => (/^\d{1,9}$/.test(v) ? Number(v) : undefined);

/** Who did it, who it is about, and the action groups. */
function parsePeople(sp: Record<string, unknown>, q: AuditQuery): void {
  const doneBy = str(sp.by);
  if (UUID.test(doneBy)) q.doneBy = doneBy;
  const about = str(sp.about);
  if (UUID.test(about)) q.about = about;
  const groups = list(sp.group).filter(isAuditGroup);
  if (groups.length) q.groups = [...new Set(groups)];
}

/** The detail, vendor and invoice. */
function parseRefs(sp: Record<string, unknown>, q: AuditQuery): void {
  const detail = whole(str(sp.detail).replace(/^#/, ""));
  if (detail) q.detail = detail;
  const vendor = str(sp.vendor);
  if (UUID.test(vendor)) q.vendorId = vendor;
  const invoice = whole(str(sp.invoice).replace(/\D+/g, ""));
  if (invoice) q.invoice = invoice;
}

/** The date preset or custom range. */
function parseDates(sp: Record<string, unknown>, q: AuditQuery): void {
  const preset = str(sp.range);
  if (DATE_PRESETS.some((p) => p.key === preset)) q.preset = preset as DatePreset;
  const from = str(sp.from);
  const to = str(sp.to);
  if (agencyDateOnly(from)) q.from = from;
  if (agencyDateOnly(to)) q.to = to;
  if ((q.from || q.to) && !q.preset) q.preset = "custom";
}

/** The query from the address bar (or an export request). Anything malformed is left out, never an error. */
export function parseAuditQuery(sp: Record<string, unknown>): AuditQuery {
  const q: AuditQuery = {};
  parsePeople(sp, q);
  parseRefs(sp, q);
  parseDates(sp, q);
  const text = str(sp.q).slice(0, 200);
  if (text) q.text = text;
  if (str(sp.system) === "0") q.system = false;
  if (str(sp.order) === "oldest") q.order = "oldest";
  const type = str(sp.type);
  if (type) q.entityType = type.slice(0, 64);
  const id = str(sp.id);
  if (id) q.entityId = id.slice(0, 64);
  return q;
}

/** The query as address-bar parameters, the inverse of parseAuditQuery. */
export function auditQueryParams(q: AuditQuery): URLSearchParams {
  const custom = q.preset === "custom";
  const pairs: Array<[string, string | number | undefined | false]> = [
    ["by", q.doneBy],
    ["about", q.about],
    ...(q.groups ?? []).map((g): [string, string] => ["group", g]),
    ["detail", q.detail],
    ["vendor", q.vendorId],
    ["invoice", q.invoice],
    ["range", q.preset],
    ["from", custom && q.from],
    ["to", custom && q.to],
    ["q", q.text],
    ["system", q.system === false && "0"],
    ["order", q.order === "oldest" && "oldest"],
    ["type", q.entityType],
    ["id", q.entityId],
  ];
  const p = new URLSearchParams();
  for (const [k, v] of pairs) if (v) p.append(k, String(v));
  return p;
}

/** The instant range of a preset or custom range, in agency time. */
export function auditRange(q: Pick<AuditQuery, "preset" | "from" | "to">, now: Date): { from?: Date; to?: Date } {
  const d = agencyDateParts(now);
  const startOfDay = (back: number) => agencyInstant(d.year, d.month, d.day - back, 0, 0);
  switch (q.preset) {
    case "today":
      return { from: startOfDay(0) };
    case "7d":
      return { from: startOfDay(6) };
    case "30d":
      return { from: startOfDay(29) };
    case "year":
      return { from: agencyInstant(d.year, 1, 1, 0, 0) };
    case "custom":
      return { from: agencyDateOnly(q.from, "start") ?? undefined, to: agencyDateOnly(q.to, "end") ?? undefined };
    default:
      return {};
  }
}

export function assertMayReadAudit(actor: Actor): void {
  if (actor.role !== "admin" && actor.role !== "coordinator") throw new ForbiddenError("Only coordinators and admins can read the audit log.");
  assertCan(actor, "audit.read");
}

const json = (col: typeof auditLog.before | typeof auditLog.after, key: string) => sql`(${col} ->> ${key})`;
const named = (key: string, value: string) => or(sql`${json(auditLog.after, key)} = ${value}`, sql`${json(auditLog.before, key)} = ${value}`)!;
const entity = (type: string, ids: SQL | string) =>
  typeof ids === "string" ? and(eq(auditLog.entityType, type), eq(auditLog.entityId, ids))! : and(eq(auditLog.entityType, type), inArray(auditLog.entityId, ids))!;

/** Every entry where the person is the subject: their account, their sign-ups, W-9s, lock overrides and invoices. */
function aboutPerson(tx: Tx, userId: string): SQL {
  return or(
    entity("user", userId),
    entity("assignment", tx.select({ id: assignments.id }).from(assignments).where(eq(assignments.userId, userId)) as unknown as SQL),
    entity("w9", tx.select({ id: w9s.id }).from(w9s).where(eq(w9s.userId, userId)) as unknown as SQL),
    entity("billing_lock_override", tx.select({ id: billingLockOverrides.id }).from(billingLockOverrides).where(eq(billingLockOverrides.userId, userId)) as unknown as SQL),
    entity("invoice", tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.payeeUserId, userId)) as unknown as SQL),
    named("userId", userId),
  )!;
}

async function aboutDetail(tx: Tx, number: number): Promise<SQL> {
  const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.number, number));
  if (!job) return sql`false`;
  const onJob = tx.select({ id: assignments.id }).from(assignments).where(eq(assignments.jobId, job.id));
  return or(
    entity("job", job.id),
    entity("assignment", onJob as unknown as SQL),
    entity("invoice", tx.select({ id: invoices.id }).from(invoices).where(inArray(invoices.assignmentId, onJob)) as unknown as SQL),
    named("jobId", job.id),
  )!;
}

function aboutVendor(tx: Tx, vendorId: string): SQL {
  return or(
    entity("vendor", vendorId),
    entity("job", tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.vendorId, vendorId)) as unknown as SQL),
    entity("invoice", tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.vendorId, vendorId)) as unknown as SQL),
    named("vendorId", vendorId),
  )!;
}

async function aboutInvoice(tx: Tx, number: number): Promise<SQL> {
  const [inv] = await tx.select({ id: invoices.id }).from(invoices).where(eq(invoices.number, number));
  if (!inv) return sql`false`;
  return or(entity("invoice", inv.id), entity("payment_issue", tx.select({ id: paymentIssues.id }).from(paymentIssues).where(eq(paymentIssues.invoiceId, inv.id)) as unknown as SQL), named("invoiceId", inv.id))!;
}

/** The distinct actions in the log matching `keep`: action groups and label search filter on these. */
async function actionsWhere(tx: Tx, keep: (action: string) => boolean): Promise<string[]> {
  const all = await tx.selectDistinct({ a: auditLog.action }).from(auditLog);
  return all.map((r) => r.a).filter(keep);
}

/** Text in the reason, the stored values or the plain-word summary. */
async function textCond(tx: Tx, text: string): Promise<SQL> {
  const t = text.toLowerCase();
  const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
  const labelled = await actionsWhere(tx, (a) => auditLabel(a).toLowerCase().includes(t));
  return or(
    ilike(auditLog.reason, like),
    ilike(auditLog.action, like),
    sql`${auditLog.after}::text ilike ${like}`,
    sql`${auditLog.before}::text ilike ${like}`,
    labelled.length ? inArray(auditLog.action, labelled) : undefined,
  )!;
}

/** The person, group, detail, vendor and invoice conditions. */
async function subjectConds(tx: Tx, q: AuditQuery): Promise<SQL[]> {
  const conds: SQL[] = [];
  if (q.doneBy) conds.push(eq(auditLog.actorUserId, q.doneBy));
  if (q.about) conds.push(aboutPerson(tx, q.about));
  if (q.groups?.length) {
    const want = new Set(q.groups);
    const actions = await actionsWhere(tx, (a) => want.has(auditGroup(a)));
    conds.push(actions.length ? inArray(auditLog.action, actions) : sql`false`);
  }
  if (q.detail) conds.push(await aboutDetail(tx, q.detail));
  if (q.vendorId) conds.push(aboutVendor(tx, q.vendorId));
  if (q.invoice) conds.push(await aboutInvoice(tx, q.invoice));
  return conds;
}

/** The SQL condition for the query. */
export async function auditWhere(tx: Tx, q: AuditQuery, now: Date): Promise<SQL | undefined> {
  const conds = await subjectConds(tx, q);
  const range = auditRange(q, now);
  if (range.from) conds.push(gte(auditLog.at, range.from));
  if (range.to) conds.push(lte(auditLog.at, range.to));
  if (q.text) conds.push(await textCond(tx, q.text));
  if (q.system === false) conds.push(isNotNull(auditLog.actorUserId));
  if (q.entityType) conds.push(eq(auditLog.entityType, q.entityType));
  if (q.entityId) conds.push(eq(auditLog.entityId, q.entityId));
  return conds.length ? and(...conds) : undefined;
}

export const auditOrder = (q: Pick<AuditQuery, "order">) => (q.order === "oldest" ? [asc(auditLog.at), asc(auditLog.id)] : [desc(auditLog.at), desc(auditLog.id)]);

/** How many entries match. */
export async function countAudit(tx: Tx, where: SQL | undefined): Promise<number> {
  const [r] = await tx.select({ n: sql<number>`count(*)::int` }).from(auditLog).where(where);
  return Number(r?.n ?? 0);
}

export type AuditRow = typeof auditLog.$inferSelect;

export type AuditChange = { field: string; before: string; after: string };

export type AuditEntryView = {
  id: string;
  at: Date;
  actorUserId: string | null;
  actorName: string | null;
  actorRole: string | null;
  system: boolean;
  action: string;
  label: string;
  group: AuditGroup;
  groupLabel: string;
  entityType: string;
  entityId: string | null;
  /** Who or what the entry is about, in words: "Detail #12 Stadium security", "W-9 of Pat Lee". */
  subject: string;
  detailNumber: number | null;
  vendorName: string | null;
  invoiceNumber: string | null;
  reason: string | null;
  /** The changed fields, readable, with secrets and W-9 contents left out. */
  changes: AuditChange[];
  ipAddress: string | null;
  device: string | null;
  before: unknown;
  after: unknown;
};

/** Keys whose values never appear in an export or print: passwords, tokens, secrets, key and file contents, tax ids. */
const SECRET_PARTS = ["password", "passcode", "secret", "token", "hash", "apikey", "api_key", "privatekey", "storagekey", "storage_key", "encrypted", "ssn", "taxid", "tax_id", "contents"];
const SECRET_NAMES = new Set(["tin", "ein", "key", "keys", "code", "otp", "content", "filebody", "filedata", "bytes", "body64", "signature", "signaturedata"]);
const W9_FIELDS = new Set(["tin", "ssn", "name", "address", "business", "classification", "form", "fields", "data"]);
export const REDACTED = "[not shown]";

function isSecretKey(key: string, entityType: string): boolean {
  const k = key.toLowerCase();
  return SECRET_NAMES.has(k) || SECRET_PARTS.some((p) => k.includes(p)) || (entityType === "w9" && W9_FIELDS.has(k));
}

/** The value with every secret-looking field replaced. W-9 records keep only their status fields. */
export function redact(value: unknown, entityType = ""): unknown {
  if (Array.isArray(value)) return value.map((v) => redact(v, entityType));
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = isSecretKey(k, entityType) ? REDACTED : redact(v, entityType);
    }
    return out;
  }
  return value;
}

const fieldLabel = (k: string) => {
  const w = k.replaceAll("_", " ").replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
  return w.charAt(0).toUpperCase() + w.slice(1);
};

function valueText(v: unknown): string {
  if (v === null || v === undefined || v === "") return "none";
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return JSON.stringify(v);
}

/** Field by field: "Rate cents: 6500 to 7000". A value that is not an object is one "Value" field. */
export function auditChanges(before: unknown, after: unknown, entityType = ""): AuditChange[] {
  const b = redact(before, entityType);
  const a = redact(after, entityType);
  const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(b) && !isObj(a)) {
    if (b === null && a === null) return [];
    return valueText(b) === valueText(a) ? [] : [{ field: "Value", before: valueText(b), after: valueText(a) }];
  }
  const bo = isObj(b) ? b : {};
  const ao = isObj(a) ? a : {};
  const keys = [...new Set([...Object.keys(bo), ...Object.keys(ao)])];
  return keys.flatMap((k) => {
    const [x, y] = [valueText(bo[k]), valueText(ao[k])];
    return x === y && isObj(b) && isObj(a) ? [] : [{ field: fieldLabel(k), before: isObj(b) ? x : "none", after: isObj(a) ? y : "none" }];
  });
}

/** The changes as one readable line each, for the CSV. */
export const changesText = (c: AuditChange[]) => c.map((x) => `${x.field}: ${x.before} to ${x.after}`).join("; ");

const ROLE_LABEL: Record<string, string> = { admin: "Admin", coordinator: "Coordinator", personnel: "Deputy", vendor: "Vendor" };
export const roleLabel = (r: string | null) => (r ? (ROLE_LABEL[r] ?? r) : null);

const textOf = (v: unknown, key: string): string | null => {
  if (!v || typeof v !== "object") return null;
  const x = (v as Record<string, unknown>)[key];
  return typeof x === "string" && x ? x : null;
};

type Lookups = {
  user: Map<string, { id: string; name: string; role: string }>;
  job: Map<string, { id: string; number: number; title: string; vendorId: string }>;
  vendor: Map<string, string>;
  asg: Map<string, { id: string; userId: string; jobId: string }>;
  w9: Map<string, { id: string; userId: string }>;
  inv: Map<string, { id: string; number: number; vendorId: string; payeeUserId: string; assignmentId: string }>;
  invJob: Map<string, string>;
  prefix: string;
};

/** Every person, detail, vendor, sign-up, W-9 and invoice the rows name, in a few batched lookups. */
async function lookups(tx: Tx, rows: AuditRow[]): Promise<Lookups> {
  const ids = (type: string) => [...new Set(rows.filter((r) => r.entityType === type && r.entityId && UUID.test(r.entityId)).map((r) => r.entityId!))];
  const some = <T>(list: string[], load: (l: string[]) => Promise<T[]>) => (list.length ? load(list) : Promise.resolve([] as T[]));
  const asg = await some(ids("assignment"), (l) => tx.select({ id: assignments.id, userId: assignments.userId, jobId: assignments.jobId }).from(assignments).where(inArray(assignments.id, l)));
  const w9Rows = await some(ids("w9"), (l) => tx.select({ id: w9s.id, userId: w9s.userId }).from(w9s).where(inArray(w9s.id, l)));
  const invRows = await some(ids("invoice"), (l) =>
    tx.select({ id: invoices.id, number: invoices.number, vendorId: invoices.vendorId, payeeUserId: invoices.payeeUserId, assignmentId: invoices.assignmentId }).from(invoices).where(inArray(invoices.id, l)),
  );
  const invAsg = await some(invRows.map((i) => i.assignmentId), (l) => tx.select({ id: assignments.id, jobId: assignments.jobId }).from(assignments).where(inArray(assignments.id, l)));
  const jobRows = await some([...new Set([...ids("job"), ...asg.map((a) => a.jobId), ...invAsg.map((a) => a.jobId)])], (l) =>
    tx.select({ id: jobs.id, number: jobs.number, title: jobs.title, vendorId: jobs.vendorId }).from(jobs).where(inArray(jobs.id, l)),
  );
  const vendorRows = await some([...new Set([...ids("vendor"), ...jobRows.map((j) => j.vendorId), ...invRows.map((i) => i.vendorId)])], (l) =>
    tx.select({ id: vendors.id, name: vendors.name }).from(vendors).where(inArray(vendors.id, l)),
  );
  const people = [...rows.map((r) => r.actorUserId), ...ids("user"), ...asg.map((a) => a.userId), ...w9Rows.map((w) => w.userId), ...invRows.map((i) => i.payeeUserId)];
  const userRows = await some([...new Set(people.filter((x): x is string => !!x))], (l) => tx.select({ id: users.id, name: users.name, role: users.role }).from(users).where(inArray(users.id, l)));
  return {
    user: new Map(userRows.map((u) => [u.id, u])),
    job: new Map(jobRows.map((j) => [j.id, j])),
    vendor: new Map(vendorRows.map((v) => [v.id, v.name])),
    asg: new Map(asg.map((a) => [a.id, a])),
    w9: new Map(w9Rows.map((w) => [w.id, w])),
    inv: new Map(invRows.map((i) => [i.id, i])),
    invJob: new Map(invAsg.map((a) => [a.id, a.jobId])),
    prefix: (await getSettings(tx)).invoiceNumberPrefix,
  };
}

const withId = (label: string, id: string | null) => (id ? `${label} ${id}` : label);

/** Who or what an entry is about, in words. */
function subjectOf(r: AuditRow, l: Lookups): string {
  const id = r.entityId ?? "";
  const name = (userId: string | undefined) => (userId ? l.user.get(userId)?.name : undefined);
  const detail = (jobId: string | undefined) => {
    const j = jobId ? l.job.get(jobId) : undefined;
    return j ? `Detail #${j.number} ${j.title}` : undefined;
  };
  switch (r.entityType) {
    case "user":
      return name(id) ?? withId("User", r.entityId);
    case "assignment": {
      const a = l.asg.get(id);
      return [name(a?.userId), detail(a?.jobId)].filter(Boolean).join(", ") || withId("Sign-up", r.entityId);
    }
    case "w9":
      return `W-9 of ${name(l.w9.get(id)?.userId) ?? "unknown person"}`;
    case "job":
      return detail(id) ?? withId("Detail", r.entityId);
    case "invoice": {
      const inv = l.inv.get(id);
      const number = inv ? `Invoice ${formatInvoiceNumber(l.prefix, inv.number)}` : undefined;
      return [number, name(inv?.payeeUserId)].filter(Boolean).join(", ") || withId("Invoice", r.entityId);
    }
    case "vendor":
      return l.vendor.get(id) ?? withId("Vendor", r.entityId);
    default:
      return withId(fieldLabel(r.entityType), r.entityId);
  }
}

/** The detail and vendor an entry concerns, through its sign-up or invoice when it is one. */
function refsOf(r: AuditRow, l: Lookups): { detailNumber: number | null; vendorName: string | null; invoiceNumber: string | null } {
  const id = r.entityId ?? "";
  const inv = l.inv.get(id);
  const viaInvoice = inv ? l.invJob.get(inv.assignmentId) : undefined;
  const jobId = r.entityType === "job" ? id : (l.asg.get(id)?.jobId ?? viaInvoice);
  const j = jobId ? l.job.get(jobId) : undefined;
  const vendorId = j?.vendorId ?? inv?.vendorId ?? (r.entityType === "vendor" ? id : undefined);
  return {
    detailNumber: j?.number ?? null,
    vendorName: (vendorId ? l.vendor.get(vendorId) : undefined) ?? null,
    invoiceNumber: inv ? formatInvoiceNumber(l.prefix, inv.number) : null,
  };
}

/** Names, numbers and subjects for a page of rows. */
export async function describeAudit(tx: Tx, rows: AuditRow[]): Promise<AuditEntryView[]> {
  const l = await lookups(tx, rows);
  return rows.map((r) => {
    const actor = r.actorUserId ? l.user.get(r.actorUserId) : undefined;
    const group = auditGroup(r.action);
    return {
      id: r.id,
      at: r.at,
      actorUserId: r.actorUserId,
      actorName: r.actorUserId ? (actor?.name ?? "Unknown") : null,
      actorRole: roleLabel(actor?.role ?? null),
      system: r.actorUserId === null,
      action: r.action,
      label: auditLabel(r.action),
      group,
      groupLabel: AUDIT_GROUPS.find((g) => g.key === group)?.label ?? "Other",
      entityType: r.entityType,
      entityId: r.entityId,
      subject: subjectOf(r, l),
      ...refsOf(r, l),
      reason: r.reason,
      changes: auditChanges(r.before, r.after, r.entityType),
      ipAddress: textOf(r.after, "ipAddress") ?? textOf(r.after, "ip"),
      device: textOf(r.after, "userAgent") ?? textOf(r.after, "device"),
      before: redact(r.before, r.entityType),
      after: redact(r.after, r.entityType),
    };
  });
}

export type AuditSearch = { rows: AuditEntryView[]; total: number; page: number; pageCount: number };

/** One page of matching entries, described, with the total. Coordinators and admins only. */
export async function searchAudit(actor: Actor, tx: Tx, q: AuditQuery, page: number, now: Date = new Date()): Promise<AuditSearch> {
  assertMayReadAudit(actor);
  const where = await auditWhere(tx, q, now);
  const total = await countAudit(tx, where);
  const pageCount = Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE));
  const p = Math.min(Math.max(1, Math.floor(page) || 1), pageCount);
  const rows = await tx
    .select()
    .from(auditLog)
    .where(where)
    .orderBy(...auditOrder(q))
    .limit(AUDIT_PAGE_SIZE)
    .offset((p - 1) * AUDIT_PAGE_SIZE);
  return { rows: await describeAudit(tx, rows), total, page: p, pageCount };
}

/** The date filter in words, or null when there is none. */
function datesLine(q: AuditQuery, now: Date): string | null {
  const range = auditRange(q, now);
  if (q.preset && q.preset !== "custom" && range.from) return `Dates: ${DATE_PRESETS.find((p) => p.key === q.preset)?.label} (from ${agencyDayKey(range.from)}, agency time)`;
  if (!range.from && !range.to) return null;
  const from = range.from ? agencyDayKey(range.from) : "the beginning";
  const to = range.to ? agencyDayKey(range.to) : "today";
  return `Dates: ${from} to ${to} (agency time)`;
}

/** The filters in plain words, for the PDF cover and the export's audit entry. */
export async function describeAuditQuery(tx: Tx, q: AuditQuery, now: Date): Promise<string[]> {
  const name = async (id: string) => (await tx.select({ name: users.name }).from(users).where(eq(users.id, id)))[0]?.name ?? "unknown person";
  const vendorName = async (id: string) => (await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, id)))[0]?.name ?? "unknown vendor";
  const lines: Array<string | null> = [
    q.doneBy ? `Done by: ${await name(q.doneBy)}` : null,
    q.about ? `About: ${await name(q.about)}` : null,
    q.groups?.length ? `Action type: ${q.groups.map((g) => AUDIT_GROUPS.find((x) => x.key === g)?.label ?? g).join(", ")}` : null,
    q.detail ? `Detail: #${q.detail}` : null,
    q.vendorId ? `Vendor: ${await vendorName(q.vendorId)}` : null,
    q.invoice ? `Invoice: ${formatInvoiceNumber((await getSettings(tx)).invoiceNumberPrefix, q.invoice)}` : null,
    datesLine(q, now),
    q.text ? `Text: "${q.text}"` : null,
    q.system === false ? "System actions: left out" : "System actions: included",
    q.entityType ? `Record type: ${[q.entityType, q.entityId].filter(Boolean).join(", ")}` : null,
  ];
  return lines.filter((x): x is string => x !== null);
}
