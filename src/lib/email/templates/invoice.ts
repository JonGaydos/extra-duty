import type { PlaceholderValues } from "@/domain/email-messages/placeholders";

export type InvoiceEmailFields = {
  invoiceNumber: string;
  jobNumber: number;
  agencyName: string;
  vendorName: string;
  payeeName: string;
  total: string;
  withW9: boolean;
  /** 0 or absent for the original; above 0 the email is the revised invoice message. */
  revision?: number;
};

/** Which email message an invoice goes out with, and its placeholder values. */
export function invoiceEmailValues(f: InvoiceEmailFields): { key: "invoice.delivery" | "invoice.revised"; values: PlaceholderValues } {
  const revised = (f.revision ?? 0) > 0;
  return {
    key: revised ? "invoice.revised" : "invoice.delivery",
    values: {
      "agency.name": f.agencyName,
      "vendor.name": f.vendorName,
      "invoice.number": f.invoiceNumber,
      "invoice.amount": f.total,
      "invoice.payee": f.payeeName,
      "invoice.revision": String(f.revision ?? 0),
      "detail.number": String(f.jobNumber),
      "invoice.w9Line": f.withW9 ? `${f.payeeName}'s W-9 is attached.` : "",
    },
  };
}
