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

/** How many of the batch's invoices are already paid, and that nothing is due on them. */
function paidSentence(paidCount: number): string {
  const one = paidCount === 1;
  return `${paidCount} of them ${one ? "is" : "are"} already paid and marked Paid; nothing is due on ${one ? "it" : "them"}.`;
}

/** One email per vendor batch: the cover summary and every invoice PDF are attached. */
export function invoiceBatchEmail(f: InvoiceBatchEmailFields): OutgoingEmail {
  const noun = f.count === 1 ? "invoice" : "invoices";
  const paidNote = f.paidCount ? ` ${paidSentence(f.paidCount)}` : "";
  const unpaid = f.paidCount ? "unpaid " : "";
  const paragraphs = [
    `${f.agencyName} is sending ${f.count} ${noun} to ${f.vendorName}.`,
    `Total due: ${f.total}.${paidNote} A summary and each invoice are attached as PDFs. Pay each ${unpaid}invoice to the payee named on it.`,
    ...f.w9Names.map((n) => `W-9 for ${n} is attached.`),
    `Reply to this message with any billing questions.`,
  ];
  const msg = simpleEmail(f.to[0], `${f.count} ${noun} from ${f.agencyName}`, paragraphs);
  return { ...msg, to: f.to, replyTo: f.replyTo };
}
