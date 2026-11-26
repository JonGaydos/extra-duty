import { isDeepStrictEqual } from "node:util";
import { and, asc, desc, eq, isNull, or } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { savedReports } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import type { Measure } from "./datasets";
import { exportReport, runReport, validateSavedSpec, type ReportResult, type ReportSpec, type SavedSpec } from "./engine";

export type SavedReport = typeof savedReports.$inferSelect;

/** Every column of the personnel activity report, in the order the page shows them. */
export const ACTIVITY_MEASURES = ["details_worked", "hours", "earned_cents", "signups", "gave_away", "late_cancels", "removals", "suspension_removals", "departure_removals", "no_shows", "cancellations", "cancellation_rate"] as const satisfies readonly Measure[];

/** Built-in reports leave the period open: pick it when you run one. */
const spec = (s: Pick<SavedSpec, "dataset" | "groupBy" | "measures"> & { filters?: SavedSpec["filters"] }): SavedSpec => ({ filters: {}, ...s });

export const BUILT_IN_REPORTS: ReadonlyArray<{ name: string; spec: SavedSpec }> = [
  // Billed is dated by the detail (invoices); paid is dated by the day it was received (payments).
  { name: "Agency billed by detail date, by day", spec: spec({ dataset: "invoices", groupBy: ["day"], measures: ["billed_count", "billed_cents"] }) },
  { name: "Agency billed by detail date, by month", spec: spec({ dataset: "invoices", groupBy: ["month"], measures: ["billed_count", "billed_cents"] }) },
  { name: "Agency billed by detail date, by year", spec: spec({ dataset: "invoices", groupBy: ["year"], measures: ["billed_count", "billed_cents"] }) },
  { name: "Agency paid by date received, by day", spec: spec({ dataset: "payments", groupBy: ["day"], measures: ["count", "paid_cents"] }) },
  { name: "Agency paid by date received, by month", spec: spec({ dataset: "payments", groupBy: ["month"], measures: ["count", "paid_cents"] }) },
  { name: "Agency paid by date received, by year", spec: spec({ dataset: "payments", groupBy: ["year"], measures: ["count", "paid_cents"] }) },
  { name: "Earnings by deputy for a period", spec: spec({ dataset: "invoices", groupBy: ["deputy"], measures: ["billed_count", "hours", "billed_cents", "paid_cents"] }) },
  { name: "Billing by vendor", spec: spec({ dataset: "invoices", groupBy: ["vendor"], measures: ["billed_count", "billed_cents", "paid_cents", "outstanding_cents"] }) },
  {
    name: "Unpaid invoices by responsible party and age",
    spec: spec({ dataset: "invoices", filters: { statuses: ["pending_review", "ready_to_send", "approved_unsent", "sent"] }, groupBy: ["responsible_party", "age_bucket"], measures: ["count", "outstanding_cents"] }),
  },
  {
    name: "Cancellations, late cancellations and no shows by deputy",
    spec: spec({ dataset: "assignments", filters: { statuses: ["canceled", "late_canceled", "no_show"] }, groupBy: ["deputy", "status"], measures: ["count"] }),
  },
  {
    name: "Fill rate by month (filled versus expired)",
    spec: spec({ dataset: "jobs", filters: { statuses: ["filled", "expired"] }, groupBy: ["month", "status"], measures: ["count"] }),
  },
  // Each month beside the season's monthly cap for it; blank where the season has no monthly cap.
  { name: "Hours by deputy against caps", spec: spec({ dataset: "assignments", filters: { statuses: ["signed_up", "billed", "paid"] }, groupBy: ["deputy", "month"], measures: ["hours", "cap_hours", "over_under_hours"] }) },
  { name: "Ops plans by status", spec: spec({ dataset: "ops_plans", groupBy: ["status"], measures: ["count"] }) },
  { name: "Personnel activity", spec: spec({ dataset: "activity", groupBy: ["deputy"], measures: [...ACTIVITY_MEASURES] }) },
];

/**
 * Idempotent. Each built-in is matched by its name (its key: unique among built-ins). A missing one is added; a
 * stored one whose definition differs is updated in place, so a database seeded earlier gains new columns and
 * filters, and the change is audited as the system. Reports people saved are never touched.
 */
export async function seedBuiltInReports(tx: Tx): Promise<void> {
  // Sequential: reads and writes in this transaction.
  for (const r of BUILT_IN_REPORTS) {
    validateSavedSpec(r.spec);
    const spec = JSON.parse(JSON.stringify(r.spec)) as Record<string, unknown>;
    const [stored] = await tx.select().from(savedReports).where(and(eq(savedReports.builtIn, true), eq(savedReports.name, r.name)));
    if (!stored) {
      await tx.insert(savedReports).values({ name: r.name, spec, builtIn: true, ownerUserId: null }).onConflictDoNothing();
      continue;
    }
    if (isDeepStrictEqual(stored.spec, spec)) continue;
    await tx.update(savedReports).set({ spec, updatedAt: new Date() }).where(eq(savedReports.id, stored.id));
    await recordAudit(tx, { actor: "system", action: "saved_report.builtin_update", entityType: "saved_report", entityId: stored.id, before: { name: stored.name, spec: stored.spec }, after: { name: r.name, spec } });
  }
}

/** The spec as stored: validated, dates as ISO text. */
const storable = (s: SavedSpec) => JSON.parse(JSON.stringify(s)) as Record<string, unknown>;

export async function saveReport(actor: Actor, tx: Tx, name: string, rawSpec: ReportSpec | SavedSpec): Promise<SavedReport> {
  assertCan(actor, "report.run");
  const clean = name.trim();
  if (!clean) throw new ValidationError("Name the report.");
  if (clean.length > 120) throw new ValidationError("The name can be at most 120 characters.");
  const valid = validateSavedSpec(rawSpec);
  const [row] = await tx.insert(savedReports).values({ ownerUserId: actor.userId, name: clean, spec: storable(valid), builtIn: false }).returning();
  await recordAudit(tx, { actor, action: "saved_report.create", entityType: "saved_report", entityId: row.id, after: { name: clean, spec: row.spec } });
  return row;
}

/** Built-ins plus the caller's own reports. */
export async function listSavedReports(actor: Actor, tx: Tx): Promise<SavedReport[]> {
  assertCan(actor, "report.run");
  return tx
    .select()
    .from(savedReports)
    .where(and(isNull(savedReports.deletedAt), or(eq(savedReports.builtIn, true), eq(savedReports.ownerUserId, actor.userId))))
    .orderBy(desc(savedReports.builtIn), asc(savedReports.name), asc(savedReports.id));
}

/** Soft delete of the caller's own report. Built-ins cannot be deleted. */
export async function deleteSavedReport(actor: Actor, tx: Tx, id: string): Promise<void> {
  assertCan(actor, "report.run");
  const [row] = await tx.select().from(savedReports).where(eq(savedReports.id, id)).for("update");
  if (!row || row.deletedAt) throw new NotFoundError("Report not found.");
  if (row.builtIn) throw new ForbiddenError("Built-in reports cannot be deleted.");
  if (row.ownerUserId !== actor.userId) throw new NotFoundError("Report not found.");
  await tx.update(savedReports).set({ deletedAt: new Date() }).where(eq(savedReports.id, id));
  await recordAudit(tx, { actor, action: "saved_report.delete", entityType: "saved_report", entityId: id, before: { name: row.name } });
}

export type Period = { from?: Date; to?: Date };

async function resolve(actor: Actor, tx: Tx, id: string, period: Period | undefined): Promise<{ row: SavedReport; spec: ReportSpec }> {
  assertCan(actor, "report.run");
  const [row] = await tx.select().from(savedReports).where(eq(savedReports.id, id));
  if (!row || row.deletedAt || (!row.builtIn && row.ownerUserId !== actor.userId)) throw new NotFoundError("Report not found.");
  const saved = validateSavedSpec(row.spec);
  const from = period?.from ?? saved.from;
  const to = period?.to ?? saved.to;
  if (!from || !to) throw new ValidationError("Choose the period to report on.");
  return { row, spec: { ...saved, from, to } };
}

/** Runs a saved or built-in report; `period` overrides the saved dates. The spec is validated again on run. */
export async function runSavedReport(actor: Actor, tx: Tx, id: string, period?: Period, now?: Date): Promise<ReportResult> {
  const { spec: s } = await resolve(actor, tx, id, period);
  return runReport(actor, tx, s, now);
}

export async function exportSavedReport(actor: Actor, tx: Tx, id: string, period: Period | undefined, format: "csv" | "pdf", now?: Date): Promise<Buffer> {
  const { row, spec: s } = await resolve(actor, tx, id, period);
  return exportReport(actor, tx, s, format, { name: row.name, now });
}
