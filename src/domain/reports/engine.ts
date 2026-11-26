import { z } from "zod";
import type { Tx } from "@/db/client";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { ValidationError } from "@/domain/errors";
import { loadAgencyHeader } from "@/domain/invoices/invoices";
import { getSettings } from "@/domain/settings/settings";
import { agencyDateOnly, agencyDateParts, agencyDayKey, agencyMonthKey, agencyWeekKey } from "@/domain/time/agency-time";
import { centsText, toCsv } from "@/lib/csv";
import { formatMoney } from "@/lib/pdf/invoice-pdf";
import { renderReportPdf } from "@/lib/pdf/report-pdf";
import { DATASETS, MAX_ROWS, ageBucket, type ActivityKind, type DatasetName, type Fact, type GroupBy, type Measure, type ReportSpec } from "./datasets";

export type { DatasetName, GroupBy, Measure, ReportSpec } from "./datasets";

/** `keys` holds each row's grouping ids (a person's id for the deputy grouping), in the order of `rows`. */
export type ReportResult = { columns: string[]; rows: Array<Array<string | number | null>>; keys: string[][]; totals: Record<string, number> };

/** A saved spec may leave the period open; it is chosen when the report runs. */
export type SavedSpec = Omit<ReportSpec, "from" | "to"> & { from?: Date; to?: Date };

const DATASET_NAMES = Object.keys(DATASETS) as [DatasetName, ...DatasetName[]];
const GROUPS = [
  "day", "week", "month", "year", "deputy", "vendor", "job_type", "location", "status", "responsible_party", "age_bucket", "action", "entity_type",
] as const satisfies readonly GroupBy[];
const MEASURES = [
  "count", "billed_count", "hours", "billed_cents", "paid_cents", "outstanding_cents", "recipients", "cap_hours", "over_under_hours",
  "details_worked", "earned_cents", "signups", "gave_away", "late_cancels", "removals", "suspension_removals", "departure_removals", "no_shows", "cancellations", "cancellation_rate",
] as const satisfies readonly Measure[];

const ids = z.array(z.string().min(1).max(200)).max(500).optional();
const noDupes = (v: readonly string[]) => new Set(v).size === v.length;

const shape = {
  dataset: z.enum(DATASET_NAMES, { error: "Choose a report type." }),
  filters: z.strictObject({ userIds: ids, vendorIds: ids, typeIds: ids, locationIds: ids, statuses: ids, rankIds: ids, qualificationIds: ids }).default({}),
  groupBy: z.array(z.enum(GROUPS, { error: "That grouping does not exist." })).max(4).refine(noDupes, "Group by each field once.").default([]),
  measures: z.array(z.enum(MEASURES, { error: "That measure does not exist." })).min(1, "Choose at least one measure.").refine(noDupes, "Choose each measure once."),
};
const reportSpecSchema = z.strictObject({
  ...shape,
  from: z.coerce.date({ error: "Choose a start date." }),
  to: z.coerce.date({ error: "Choose an end date." }),
});
const savedSpecSchema = z.strictObject({
  ...shape,
  from: z.coerce.date({ error: "Choose a start date." }).optional(),
  to: z.coerce.date({ error: "Choose an end date." }).optional(),
});

/** A date-only from is the start of that agency day, and a date-only to is its end. */
function agencyDates(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const o = raw as Record<string, unknown>;
  return { ...o, from: agencyDateOnly(o.from, "start") ?? o.from, to: agencyDateOnly(o.to, "end") ?? o.to };
}

function parseWith<T>(schema: z.ZodType<T>, raw: unknown): T {
  const r = schema.safeParse(agencyDates(raw));
  if (!r.success) {
    const i = r.error.issues[0];
    const where = i.path.length > 0 ? `${i.path.join(".")}: ` : "";
    throw new ValidationError(`${where}${i.message}`);
  }
  return r.data;
}

/** Every filter the spec sets must be one the dataset declares. */
function checkFilters(d: (typeof DATASETS)[keyof typeof DATASETS], spec: SavedSpec): void {
  for (const [name, values] of Object.entries(spec.filters)) {
    if (!values || values.length === 0) continue;
    if (!d.filters.includes(name as never)) throw new ValidationError(`${d.title} reports cannot be filtered by ${name}.`);
  }
}

/** The dataset must declare every grouping, measure, filter and status the spec asks for. */
function checkCapabilities(spec: SavedSpec): void {
  const d = DATASETS[spec.dataset];
  for (const g of spec.groupBy) if (!d.groupings.includes(g)) throw new ValidationError(`${d.title} reports cannot be grouped by ${g}.`);
  for (const m of spec.measures) if (!d.measures.includes(m)) throw new ValidationError(`${d.title} reports do not support the ${m} measure.`);
  checkFilters(d, spec);
  if (spec.measures.some((m) => m === "cap_hours" || m === "over_under_hours") && !spec.groupBy.includes("month")) {
    throw new ValidationError("Cap measures compare each month with its cap, so group by month.");
  }
  if (d.statuses) {
    const bad = (spec.filters.statuses ?? []).find((s) => !d.statuses!.includes(s));
    if (bad) throw new ValidationError(`${bad} is not a status for ${d.title} reports.`);
  }
}

/** Validates a saved report's spec (period optional). */
export function validateSavedSpec(raw: unknown): SavedSpec {
  const spec = parseWith(savedSpecSchema, raw);
  checkCapabilities(spec);
  if (spec.from && spec.to) checkPeriod(spec.from, spec.to);
  return spec;
}

function checkPeriod(from: Date, to: Date): void {
  if (to.getTime() < from.getTime()) throw new ValidationError("The end date is before the start date.");
  const limit = new Date(from);
  limit.setUTCFullYear(limit.getUTCFullYear() + 5);
  if (to.getTime() > limit.getTime()) throw new ValidationError("A report can cover at most 5 years. Choose a shorter period.");
}

/** Validates a spec to run: Zod shape, period (required, at most 5 years), then what the dataset supports. */
function validateReportSpec(raw: unknown): ReportSpec {
  const spec = parseWith(reportSpecSchema, raw);
  checkCapabilities(spec);
  checkPeriod(spec.from, spec.to);
  return spec;
}

const nameOf = (v: string | null, fallback: string) => v ?? fallback;
type Dim = (f: Fact, weekStartsOn: 0 | 1 | 2 | 3 | 4 | 5 | 6) => { key: string; label: string };
const same = (s: string) => ({ key: s, label: s });
const DIMS: Record<GroupBy, Dim> = {
  day: (f) => same(agencyDayKey(f.at)),
  week: (f, w) => same(agencyWeekKey(f.at, w)),
  month: (f) => same(agencyMonthKey(f.at)),
  year: (f) => same(String(agencyDateParts(f.at).year)),
  deputy: (f) => ({ key: f.userId ?? "", label: nameOf(f.userName, "None") }),
  vendor: (f) => ({ key: f.vendorId ?? "", label: nameOf(f.vendorName, "None") }),
  job_type: (f) => ({ key: f.typeId ?? "", label: nameOf(f.typeName, "None") }),
  location: (f) => ({ key: f.locationId ?? "", label: nameOf(f.locationName, "No location") }),
  status: (f) => same(f.status),
  responsible_party: (f) => same(nameOf(f.responsibleParty, "none")),
  age_bucket: (f) => same(f.ageDays === null ? "n/a" : ageBucket(f.ageDays)),
  action: (f) => same(nameOf(f.action, "none")),
  entity_type: (f) => same(nameOf(f.entityType, "none")),
};

const sumBy = (facts: Fact[], pick: (f: Fact) => number) => facts.reduce((n, f) => n + pick(f), 0);
const countOf = (facts: Fact[], ...kinds: ActivityKind[]) => facts.filter((f) => f.activity !== null && kinds.includes(f.activity)).length;
// A vendor late cancel is shown but never counts against the person (owner ruling, Task 39c). A removal by
// suspension, or by the person leaving the agency, is a sign-up with its own column, never a cancellation (owner
// decisions, Tasks 40b and 44a).
const CANCEL_KINDS: ActivityKind[] = ["gave_away", "removed", "no_show"];
const SIGNUP_KINDS: ActivityKind[] = ["worked", "late_cancel", "gave_away", "removed", "suspension_removed", "departure_removed", "no_show", "canceled", "open"];
const MEASURE_FN: Record<Measure, (facts: Fact[]) => number | null> = {
  count: (fs) => fs.length,
  billed_count: (fs) => sumBy(fs, (f) => f.billedCount),
  // Whole minutes summed first, then shown as hours rounded to two decimals.
  hours: (fs) => hoursOf(sumBy(fs, (f) => f.minutes)),
  billed_cents: (fs) => sumBy(fs, (f) => f.billed),
  paid_cents: (fs) => sumBy(fs, (f) => f.paid),
  outstanding_cents: (fs) => sumBy(fs, (f) => f.outstanding),
  recipients: (fs) => sumBy(fs, (f) => f.recipients),
  // The season's monthly cap for the group's month (the larger one if a month spans two seasons); null when no cap applies.
  cap_hours: (fs) => {
    const caps = fs.map((f) => f.monthCapMinutes).filter((c): c is number => c !== null);
    return caps.length === 0 ? null : hoursOf(Math.max(...caps));
  },
  // Positive is over the cap, negative is under it.
  over_under_hours: (fs) => {
    const cap = MEASURE_FN.cap_hours(fs);
    return cap === null ? null : Math.round((MEASURE_FN.hours(fs)! - cap) * 100) / 100;
  },
  details_worked: (fs) => countOf(fs, "worked"),
  earned_cents: (fs) => sumBy(fs, (f) => f.earned),
  signups: (fs) => countOf(fs, ...SIGNUP_KINDS),
  gave_away: (fs) => countOf(fs, "gave_away"),
  late_cancels: (fs) => countOf(fs, "late_cancel"),
  removals: (fs) => countOf(fs, "removed"),
  suspension_removals: (fs) => countOf(fs, "suspension_removed"),
  departure_removals: (fs) => countOf(fs, "departure_removed"),
  no_shows: (fs) => countOf(fs, "no_show"),
  cancellations: (fs) => countOf(fs, ...CANCEL_KINDS),
  // Percent of sign-ups, to one decimal; null with no sign-ups.
  cancellation_rate: (fs) => {
    const signups = countOf(fs, ...SIGNUP_KINDS);
    return signups === 0 ? null : Math.round((countOf(fs, ...CANCEL_KINDS) / signups) * 1000) / 10;
  },
};
const hoursOf = (minutes: number) => Math.round((minutes / 60) * 100) / 100;
const PER_GROUP: ReadonlySet<Measure> = new Set(["cap_hours", "over_under_hours"]);

/** Coordinators and admins. Time grouping is in agency time; `now` sets invoice age. */
export async function runReport(actor: Actor, tx: Tx, rawSpec: ReportSpec, now: Date = new Date()): Promise<ReportResult> {
  assertCan(actor, "report.run");
  const spec = validateReportSpec(rawSpec);
  const facts = await DATASETS[spec.dataset].load(tx, spec, now);
  if (facts.length > MAX_ROWS) throw new ValidationError(`This report covers more than ${MAX_ROWS.toLocaleString("en-US")} records. Narrow the date range or add filters.`);

  const { weekStartsOn } = await getSettings(tx);
  const week = weekStartsOn as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  const groups = new Map<string, { labels: string[]; keys: string[]; facts: Fact[] }>();
  for (const f of facts) {
    const dims = spec.groupBy.map((g) => DIMS[g](f, week));
    const key = JSON.stringify(dims.map((d) => d.key));
    const g = groups.get(key) ?? { labels: dims.map((d) => d.label), keys: dims.map((d) => d.key), facts: [] };
    g.facts.push(f);
    groups.set(key, g);
  }
  const ordered = [...groups.values()].sort((a, b) => {
    for (let i = 0; i < a.labels.length; i++) if (a.labels[i] !== b.labels[i]) return a.labels[i] < b.labels[i] ? -1 : 1;
    return 0;
  });
  const shown = spec.groupBy.length === 0 ? [{ labels: [], keys: [], facts }] : ordered;
  const rows = shown.map((g) => [...g.labels, ...spec.measures.map((m) => MEASURE_FN[m](g.facts))]);
  // Cap measures only mean something per month, so their total is the sum of the rows.
  const totals = Object.fromEntries(
    spec.measures.map((m, i) => [m, PER_GROUP.has(m) ? rows.reduce((n, r) => n + ((r[spec.groupBy.length + i] as number | null) ?? 0), 0) : MEASURE_FN[m](facts)!]),
  );
  return { columns: [...spec.groupBy, ...spec.measures], rows, keys: shown.map((g) => g.keys), totals };
}

export const LABEL: Record<GroupBy | Measure, string> = {
  day: "Day",
  week: "Week of",
  month: "Month",
  year: "Year",
  deputy: "Deputy",
  vendor: "Vendor",
  job_type: "Job type",
  location: "Location",
  status: "Status",
  responsible_party: "Responsible party",
  age_bucket: "Age (days)",
  action: "Action",
  entity_type: "Entity type",
  count: "Count",
  hours: "Hours",
  billed_cents: "Billed",
  paid_cents: "Paid",
  outstanding_cents: "Outstanding",
  recipients: "Recipients",
  billed_count: "Billed details",
  cap_hours: "Monthly cap (hours)",
  over_under_hours: "Over (+) or under (-) cap (hours)",
  details_worked: "Details worked",
  earned_cents: "Earnings",
  signups: "Sign-ups",
  gave_away: "Gave away",
  late_cancels: "Vendor late cancel",
  removals: "Removed by coordinator",
  suspension_removals: "Removed by suspension",
  departure_removals: "Left the agency",
  no_shows: "No-shows",
  cancellations: "Cancellations",
  cancellation_rate: "Cancellation rate (%)",
};

const DATASET_LABEL: Partial<Record<DatasetName, Partial<Record<GroupBy | Measure, string>>>> = {
  audit: { deputy: "Actor" },
  messages: { deputy: "Sender" },
  activity: { deputy: "Person", hours: "Hours worked" },
};

/** The deputy grouping is the actor on the audit log, the sender on messages and the person on the activity report. */
export const labelFor = (dataset: DatasetName, c: GroupBy | Measure) => DATASET_LABEL[dataset]?.[c] ?? LABEL[c];
const isMoney = (c: string) => c.endsWith("_cents");

export type ExportOptions = { /** Title of a saved report; defaults to the dataset name. */ name?: string; now?: Date };

/** One exported cell: blank for null, money columns through `money`, anything else as text. */
function cellText(v: string | number | null, money: boolean, formatMoneyCell: (cents: number) => string): string {
  if (v === null) return "";
  if (typeof v === "number" && money) return formatMoneyCell(v);
  return String(v);
}

/** CSV (header row, formula-safe) or PDF (agency header, name, period, paginated table). Audited. */
export async function exportReport(actor: Actor, tx: Tx, rawSpec: ReportSpec, format: "csv" | "pdf", opts: ExportOptions = {}): Promise<Buffer> {
  assertCan(actor, "report.run");
  if (format !== "csv" && format !== "pdf") throw new ValidationError("Choose CSV or PDF.");
  const spec = validateReportSpec(rawSpec);
  const result = await runReport(actor, tx, spec, opts.now);
  await recordAudit(tx, {
    actor,
    action: "report.export",
    entityType: "report",
    entityId: spec.dataset,
    after: { name: opts.name ?? null, format, dataset: spec.dataset, from: spec.from, to: spec.to, filters: spec.filters, groupBy: spec.groupBy, measures: spec.measures, rows: result.rows.length },
  });

  const nGroups = spec.groupBy.length;
  if (format === "csv") {
    const header = result.columns.map((c) => (isMoney(c) ? `${labelFor(spec.dataset, c as Measure)} ($)` : labelFor(spec.dataset, c as GroupBy | Measure)));
    const lines = result.rows.map((r) => r.map((v, i) => cellText(v, isMoney(result.columns[i]), centsText)));
    return Buffer.from(toCsv(header, lines), "utf8");
  }
  const fmt = (v: string | number | null, i: number) => cellText(v, isMoney(result.columns[i]), formatMoney);
  const title = opts.name ?? `${DATASETS[spec.dataset].title} report`;
  return renderReportPdf({
    agency: await loadAgencyHeader(tx),
    name: title,
    period: `${agencyDayKey(spec.from)} to ${agencyDayKey(spec.to)}`,
    columns: result.columns.map((c, i) => ({ label: labelFor(spec.dataset, c as GroupBy | Measure), right: i >= nGroups })),
    rows: result.rows.map((r) => r.map((v, i) => fmt(v, i))),
    totals: nGroups > 0 ? ["Total", ...result.columns.slice(1).map((c, i) => (i + 1 >= nGroups ? fmt(result.totals[c], i + 1) : ""))] : null,
  });
}
