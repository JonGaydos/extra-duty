import { simpleEmail } from "../format";
import type { OutgoingEmail } from "../types";

export type InvoiceEmailFields = {
  to: string[];
  replyTo: string;
  invoiceNumber: string;
  jobNumber: number;
  agencyName: string;
  payeeName: string;
  total: string;
  withW9: boolean;
  /** 0 or absent for the original; above 0 the email says Revised. */
  revision?: number;
};

export function invoiceEmail(f: InvoiceEmailFields): OutgoingEmail {
  const revised = (f.revision ?? 0) > 0;
  const paragraphs = [
    `${f.agencyName} is sending ${revised ? "revised " : ""}invoice ${f.invoiceNumber} for Detail #${f.jobNumber}, worked by ${f.payeeName}.`,
    ...(revised ? [`This is revision ${f.revision} and replaces any earlier copy.`] : []),
    `Amount due: ${f.total}. The invoice is attached as a PDF.`,
    ...(f.withW9 ? [`${f.payeeName}'s W-9 is attached.`] : []),
    `Reply to this message with any billing questions.`,
  ];
  const msg = simpleEmail(f.to[0], `${revised ? "Revised invoice" : "Invoice"} ${f.invoiceNumber} for Detail #${f.jobNumber}`, paragraphs);
  return { ...msg, to: f.to, replyTo: f.replyTo };
}
