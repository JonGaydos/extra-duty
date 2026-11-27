/**
 * Run by tsx-runtime.test.ts in a child process started the way the Docker worker starts: tsx with the entrypoint's
 * flags. Renders an invoice PDF and a batch cover PDF and writes both, base64, to stdout as JSON.
 */
import { renderBatchCoverPdf } from "@/lib/pdf/batch-cover-pdf";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";

const agency = { name: "Test County Sheriff's Office", sheriffName: "Pat Lane", address: "", phone: "", website: "", logo: null };
const at = new Date("2026-12-04T22:00:00Z");

const invoice = await renderInvoicePdf({
  number: "ED-000001",
  revision: 0,
  kind: "detail",
  issuedAt: at,
  vendor: { name: "Test Vendor", billingEmails: ["ap@vendor.example"] },
  job: { number: 1, title: "Test detail", location: "1 Main St", startAt: at, endAt: new Date(at.getTime() + 4 * 3600_000) },
  payee: { name: "Test Deputy", mailingAddress: "1 Oak Lane", email: "deputy@example.test" },
  agency,
  workedMinutes: 240,
  minutes: 240,
  minimumMinutes: 240,
  rateCents: 5000,
  totalCents: 20000,
  paid: null,
  replyTo: "billing@sheriff.example",
});

const cover = await renderBatchCoverPdf({
  agency,
  vendorName: "Test Vendor",
  sentAt: at,
  replyTo: "billing@sheriff.example",
  rows: [{ number: "ED-000001", jobNumber: 1, jobTitle: "Test detail", jobStartAt: at, payeeName: "Test Deputy", totalCents: 20000 }],
});

process.stdout.write(JSON.stringify({ invoice: invoice.toString("base64"), cover: cover.toString("base64") }));
