import { simpleEmail } from "../format";
import type { OutgoingEmail } from "../types";

export type InvoiceBatchEmailFields = {
  to: string[];
  replyTo: string;
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

/** One email per vendor batch: the cover summary and every invoice PDF are attached. */
export function invoiceBatchEmail(f: InvoiceBatchEmailFields): OutgoingEmail {
  const noun = f.count === 1 ? "invoice" : "invoices";
  const paragraphs = [
    `${f.agencyName} is sending ${f.count} ${noun} to ${f.vendorName}.`,
    `Total due: ${f.total}.${f.paidCount ? ` ${f.paidCount} of them ${f.paidCount === 1 ? "is" : "are"} already paid and marked Paid; nothing is due on ${f.paidCount === 1 ? "it" : "them"}.` : ""} A summary and each invoice are attached as PDFs. Pay each ${f.paidCount ? "unpaid " : ""}invoice to the payee named on it.`,
    ...f.w9Names.map((n) => `W-9 for ${n} is attached.`),
    `Reply to this message with any billing questions.`,
  ];
  const msg = simpleEmail(f.to[0], `${f.count} ${noun} from ${f.agencyName}`, paragraphs);
  return { ...msg, to: f.to, replyTo: f.replyTo };
}
