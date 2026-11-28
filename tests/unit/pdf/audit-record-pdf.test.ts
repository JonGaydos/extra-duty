import { describe, expect, test } from "vitest";
import { PDFParse } from "pdf-parse";
import { AUDIT_STATEMENT, renderAuditRecordPdf, type AuditPdfEntry } from "@/lib/pdf/audit-record-pdf";

const agency = { name: "Bayside County Sheriff's Office", sheriffName: "Pat Lane", address: "", phone: "", website: "", logo: null };
const entry = (i: number): AuditPdfEntry => ({
  id: `0190a000-0000-7000-8000-${String(i).padStart(12, "0")}`,
  when: "Jun 10, 2035, 10:00 AM CDT",
  who: "Robin Castillo (Coordinator)",
  action: "Detail changed",
  subject: `Detail #${i} Stadium security`,
  reason: i % 2 ? "Vendor asked for a later start" : null,
  changes: [
    { field: "Start at", before: "2035-06-10T22:00:00.000Z", after: "2035-06-10T23:00:00.000Z" },
    { field: "Rate cents", before: "6500", after: "7000" },
  ],
  context: "No IP address or device recorded.",
});

describe("the Audit Record PDF", () => {
  test("cover block, each entry, signature lines, and page X of Y with the record ID and integrity code on every page", async () => {
    const integrity = "a".repeat(64);
    const pdf = await renderAuditRecordPdf({
      agency,
      recordId: "AR-000012",
      integrity,
      filters: ["Done by: Robin Castillo", "System actions: included"],
      generatedBy: "Lee Avalos (Admin)",
      generatedAt: "Jun 15, 2035, 12:00 PM CDT",
      entries: Array.from({ length: 30 }, (_, i) => entry(i + 1)),
    });
    const parsed = new PDFParse({ data: new Uint8Array(pdf) });
    const { text, total, pages } = await parsed.getText();
    expect(total).toBeGreaterThan(2);
    for (const s of ["Bayside County Sheriff's Office", "Audit Record", "AR-000012", "Done by: Robin Castillo", "Number of entries", "30", "Lee Avalos (Admin)", "Jun 15, 2035, 12:00 PM CDT", "Prepared by", "Reviewed by", "Signature", "Detail #30 Stadium security", "Vendor asked for a later start", "Rate cents"]) {
      expect(text).toContain(s);
    }
    expect(text.replace(/\s+/g, " ")).toContain(AUDIT_STATEMENT);
    for (const [i, p] of pages.entries()) {
      expect(p.text).toContain(`Page ${i + 1} of ${total}`);
      expect(p.text).toContain("Record AR-000012");
      expect(p.text).toContain(`Integrity ${integrity}`);
    }
  });
});
