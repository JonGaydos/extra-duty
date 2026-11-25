import type { Tx } from "@/db/client";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { formatInvoiceNumber, loadAgencyHeader } from "@/domain/invoices/invoices";
import { getSettings } from "@/domain/settings/settings";
import { agencyDateParts, agencyDayKey } from "@/domain/time/agency-time";
import type { Cents } from "@/domain/types";
import { centsText, toCsv } from "@/lib/csv";
import { formatDate, formatMoney } from "@/lib/pdf/invoice-pdf";
import { renderTaxSummaryPdf } from "@/lib/pdf/report-pdf";
import { ValidationError } from "@/domain/errors";
import { isBilled, loadUserInvoices, type PaidDateSource } from "./earnings";

export type TaxSection = "paid" | "unpaid" | "written_off";

export type TaxRow = {
  invoiceId: string;
  /** Display number, for example ED-000001. */
  invoiceNumber: string;
  jobNumber: number;
  jobTitle: string;
  vendorName: string;
  jobDate: string;
  totalCents: Cents;
  status: "pending_review" | "ready_to_send" | "approved_unsent" | "sent" | "returned" | "paid" | "written_off";
  /** `paid`: received in the year. `unpaid`: billed in the year and not paid by year end. `written_off`: never paid. */
  section: TaxSection;
  deputyPaidAt: Date | null;
  vendorPaidAt: Date | null;
  /** The date this payment is counted on (the deputy's received date, or a coordinator's close); null when not paid. */
  paidAt: Date | null;
  /** Where the paid date came from; null for rows that were not paid. */
  paidDateSource: PaidDateSource | null;
  /** True when the counted date and the vendor's reported date fall in different calendar years (agency time). */
  yearMismatch: boolean;
};

export type TaxYearSummary = {
  year: number;
  payee: { name: string; mailingAddress: string };
  byVendor: Array<{ vendorId: string; vendorName: string; paidCents: Cents; details: number }>;
  totalPaidCents: Cents;
  unpaidBilledCents: Cents;
  rows: TaxRow[];
};

const SECTION_ORDER: Record<TaxSection, number> = { paid: 0, unpaid: 1, written_off: 2 };
const SECTION_LABEL: Record<TaxSection, string> = { paid: "Paid", unpaid: "Billed, unpaid", written_off: "Written off" };

function checkYear(year: number): void {
  if (!Number.isInteger(year) || year < 1970 || year > 2200) throw new ValidationError("Choose a valid year.");
}

/**
 * Cash basis: an invoice counts in the year the deputy marked it received (or a coordinator closed it as paid).
 * Billed-but-unpaid is the year's details still unpaid at year end; written off invoices are listed and counted in neither.
 */
export async function taxYearSummary(actor: Actor, tx: Tx, userId: string, year: number): Promise<TaxYearSummary> {
  checkYear(year);
  const { user, rows: invoices } = await loadUserInvoices(actor, tx, userId);
  const { invoiceNumberPrefix } = await getSettings(tx);
  const rows: TaxRow[] = [];
  const vendors = new Map<string, { vendorName: string; paidCents: Cents; details: number }>();
  let totalPaidCents = 0;
  let unpaidBilledCents = 0;

  for (const r of invoices) {
    if (r.status === "returned") continue;
    const jobYear = agencyDateParts(r.jobStartAt).year;
    const paidYear = r.paid ? agencyDateParts(r.paid.at).year : null;
    let section: TaxSection | null = null;
    if (r.status === "written_off") {
      if (jobYear === year) section = "written_off";
    } else if (paidYear === year) {
      section = "paid";
    } else if (isBilled(r.status) && jobYear === year && (paidYear === null || paidYear > year)) {
      section = "unpaid";
    }
    if (!section) continue;

    if (section === "paid") {
      totalPaidCents += r.totalCents;
      const v = vendors.get(r.vendorId) ?? { vendorName: r.vendorName, paidCents: 0, details: 0 };
      v.paidCents += r.totalCents;
      v.details += 1;
      vendors.set(r.vendorId, v);
    } else if (section === "unpaid") {
      unpaidBilledCents += r.totalCents;
    }
    rows.push({
      invoiceId: r.invoiceId,
      invoiceNumber: formatInvoiceNumber(invoiceNumberPrefix, r.number),
      jobNumber: r.jobNumber,
      jobTitle: r.jobTitle,
      vendorName: r.vendorName,
      jobDate: agencyDayKey(r.jobStartAt),
      totalCents: r.totalCents,
      status: r.status,
      section,
      deputyPaidAt: r.deputyPaidAt,
      vendorPaidAt: r.vendorPaidAt,
      paidAt: r.paid?.at ?? null,
      paidDateSource: section === "paid" ? r.paid!.source : null,
      yearMismatch: r.paid !== null && r.vendorPaidAt !== null && agencyDateParts(r.paid.at).year !== agencyDateParts(r.vendorPaidAt).year,
    });
  }
  rows.sort((a, b) => SECTION_ORDER[a.section] - SECTION_ORDER[b.section] || (a.jobDate < b.jobDate ? -1 : a.jobDate > b.jobDate ? 1 : a.invoiceNumber < b.invoiceNumber ? -1 : 1));
  const byVendor = [...vendors.entries()]
    .map(([vendorId, v]) => ({ vendorId, ...v }))
    .sort((a, b) => (a.vendorName < b.vendorName ? -1 : a.vendorName > b.vendorName ? 1 : a.vendorId < b.vendorId ? -1 : 1));
  return { year, payee: { name: user.name, mailingAddress: user.mailingAddress ?? "" }, byVendor, totalPaidCents, unpaidBilledCents, rows };
}

const day = (d: Date | null) => (d ? agencyDayKey(d) : "");
const SOURCE_LABEL: Record<PaidDateSource, string> = { deputy: "Deputy", coordinator_close: "Coordinator close" };

const CSV_HEADER = ["Invoice", "Job", "Vendor", "Job date", "Total", "Status", "Section", "Deputy received", "Vendor reported paid", "Date counted", "Counted from", "Year mismatch"];

/** CSV or PDF (agency header). Audited: who exported whose summary. */
export async function exportTaxSummary(actor: Actor, tx: Tx, userId: string, year: number, format: "pdf" | "csv"): Promise<Buffer> {
  if (format !== "pdf" && format !== "csv") throw new ValidationError("Choose PDF or CSV.");
  const summary = await taxYearSummary(actor, tx, userId, year);
  await recordAudit(tx, { actor, action: "tax_summary.export", entityType: "user", entityId: userId, after: { year, format, rows: summary.rows.length } });

  if (format === "csv") {
    const lines = summary.rows.map((r) => [
      r.invoiceNumber,
      `${r.jobNumber} ${r.jobTitle}`,
      r.vendorName,
      r.jobDate,
      centsText(r.totalCents),
      r.status,
      SECTION_LABEL[r.section],
      day(r.deputyPaidAt),
      day(r.vendorPaidAt),
      day(r.paidAt),
      r.paidDateSource ? SOURCE_LABEL[r.paidDateSource] : "",
      r.yearMismatch ? "Yes" : "No",
    ]);
    return Buffer.from(toCsv(CSV_HEADER, lines), "utf8");
  }

  const rows = summary.rows.map((r) => [
    r.invoiceNumber,
    `#${r.jobNumber} ${r.jobTitle}`,
    r.vendorName,
    r.jobDate,
    formatMoney(r.totalCents),
    r.paidAt ? formatDate(r.paidAt) : "",
    r.vendorPaidAt ? formatDate(r.vendorPaidAt) : "",
    [r.section === "paid" ? "" : SECTION_LABEL[r.section], r.paidDateSource === "coordinator_close" ? "Closed as paid by coordinator" : "", r.yearMismatch ? "Dates in different years" : ""].filter(Boolean).join("; "),
  ]);
  return renderTaxSummaryPdf({
    agency: await loadAgencyHeader(tx),
    year,
    payee: summary.payee,
    byVendor: summary.byVendor,
    totalPaidCents: summary.totalPaidCents,
    unpaidBilledCents: summary.unpaidBilledCents,
    rows,
  });
}
