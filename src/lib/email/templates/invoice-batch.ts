import type { PlaceholderValues } from "@/domain/email-messages/placeholders";

export type InvoiceBatchEmailFields = {
  agencyName: string;
  vendorName: string;
  count: number;
  /** Total due: the unpaid invoices only. */
  total: string;
  /** Invoices in the batch already paid (sent as paid versions). */
  paidCount?: number;
  /** Payees whose W-9 is attached. */
  w9Names: string[];
};

/** How many of the batch's invoices are already paid, and that nothing is due on them. */
function paidSentence(paidCount: number): string {
  const one = paidCount === 1;
  return `${paidCount} of them ${one ? "is" : "are"} already paid and marked Paid; nothing is due on ${one ? "it" : "them"}.`;
}

/** The placeholder values of a vendor batch's cover email (the "Invoice batch cover email" message). */
export function invoiceBatchValues(f: InvoiceBatchEmailFields): PlaceholderValues {
  return {
    "agency.name": f.agencyName,
    "vendor.name": f.vendorName,
    "batch.count": `${f.count} ${f.count === 1 ? "invoice" : "invoices"}`,
    "invoice.amount": f.total,
    "batch.paidNote": f.paidCount ? paidSentence(f.paidCount) : "",
    "batch.payWord": f.paidCount ? "unpaid invoice" : "invoice",
    "batch.w9Lines": f.w9Names.map((n) => `W-9 for ${n} is attached.`).join("\n\n"),
  };
}
