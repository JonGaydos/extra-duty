import { describe, expect, test } from "vitest";
import { PDFParse } from "pdf-parse";
import { renderBatchCoverPdf } from "@/lib/pdf/batch-cover-pdf";
import { invoiceBatchEmail } from "@/lib/email/templates/invoice-batch";
import { agencyInstant } from "@/domain/time/agency-time";

const agency = { name: "Bayside County Sheriff's Office", sheriffName: "Pat Lane", address: "", phone: "", website: "", logo: null };

describe("batch cover summary", () => {
  test("lists each invoice with detail, date, payee and amount, and a grand total on one page", async () => {
    const pdf = await renderBatchCoverPdf({
      agency,
      vendorName: "Lakeside Stadium",
      sentAt: agencyInstant(2026, 12, 4, 9, 0),
      replyTo: "billing@sheriff.example",
      rows: [
        { number: "ED-000041", jobNumber: 17, jobTitle: "Stadium security", jobStartAt: agencyInstant(2026, 11, 27, 17, 0), payeeName: "Quinn Okafor", totalCents: 42000 },
        { number: "ED-000042", jobNumber: 18, jobTitle: "Parking lot", jobStartAt: agencyInstant(2026, 11, 28, 17, 0), payeeName: "Sam Ortiz", totalCents: 123456 },
      ],
    });
    const parsed = new PDFParse({ data: new Uint8Array(pdf) });
    const { text, total } = await parsed.getText();
    expect(total).toBe(1);
    expect(text).not.toContain("Page 1 of");
    for (const s of ["Invoice summary", "Lakeside Stadium", "ED-000041", "ED-000042", "#17 Stadium security", "Quinn Okafor", "$420.00", "$1,234.56", "$1,654.56", "2 invoices"]) {
      expect(text).toContain(s);
    }
    expect(text).not.toMatch(/agency range/i);
  });

  test("40 invoices run onto more pages: each page repeats the table header and the grand total comes once, at the end", async () => {
    const rows = Array.from({ length: 40 }, (_, i) => ({
      number: `ED-${String(100 + i).padStart(6, "0")}`,
      jobNumber: 200 + i,
      jobTitle: i % 3 === 0 ? "Stadium security for the regional championship weekend, north gates" : "Parking lot",
      jobStartAt: agencyInstant(2026, 11, 1 + (i % 28), 17, 0),
      payeeName: i % 4 === 0 ? "Alexandria Montgomery-Whitfield" : "Sam Ortiz",
      totalCents: 42000,
    }));
    const pdf = await renderBatchCoverPdf({ agency, vendorName: "Lakeside Stadium", sentAt: agencyInstant(2026, 12, 4, 9, 0), replyTo: "billing@sheriff.example", rows });
    const { pages, text } = await new PDFParse({ data: new Uint8Array(pdf) }).getText();
    expect(pages.length).toBeGreaterThan(1);
    for (const page of pages) {
      expect(page.text).toMatch(/Invoice\s+Detail\s+Date\s+Payee\s+Amount/i);
    }
    for (const r of rows) expect(text).toContain(r.number);
    const grand = "$16,800.00";
    pages.forEach((page, i) => expect(page.text.includes(grand), `page ${i + 1}`).toBe(i === pages.length - 1));
    expect(pages.at(-1)!.text).toMatch(/Total due\s+\$16,800\.00/);
    expect(pages[1].text).toContain("Invoice summary for Lakeside Stadium, continued");
    pages.forEach((page, i) => expect(page.text).toContain(`Page ${i + 1} of ${pages.length}`));
  });

  test("the email names the count, the total and the W-9s attached", () => {
    const msg = invoiceBatchEmail({ to: ["ap@x.example"], replyTo: "b@s.example", agencyName: "BCSO", vendorName: "Lakeside", count: 2, total: "$840.00", w9Names: ["Quinn Okafor"] });
    expect(msg.subject).toBe("2 invoices from BCSO");
    expect(msg.text).toContain("$840.00");
    expect(msg.text).toContain("A summary and each invoice are attached");
    expect(msg.text).not.toContain("one-page");
    expect(msg.text).toContain("W-9 for Quinn Okafor is attached.");
    expect(msg.text).not.toMatch(/agency range/i);
    expect(invoiceBatchEmail({ to: ["a@x.example"], replyTo: "b@s.example", agencyName: "BCSO", vendorName: "L", count: 1, total: "$1.00", w9Names: [] }).subject).toBe("1 invoice from BCSO");
  });
});
