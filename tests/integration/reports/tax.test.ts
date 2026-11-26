import { beforeAll, describe, expect, test } from "vitest";
import { PDFParse } from "pdf-parse";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { auditLog, vendors } from "@/db/schema";
import { exportTaxSummary, taxYearSummary } from "@/domain/reports/tax";
import { ForbiddenError } from "@/domain/errors";
import { at, buildFixture } from "./helpers";

describe("taxYearSummary", () => {
  const get = useTestDb();
  let fx: Awaited<ReturnType<typeof buildFixture>>;
  const run = <T>(fn: Parameters<ReturnType<typeof get>["db"]["transaction"]>[0] extends (tx: infer X) => unknown ? (tx: X) => Promise<T> : never) => get().db.transaction(fn);

  beforeAll(async () => {
    fx = await buildFixture(get().db, "tax");
  });

  test("2027 counts what the deputy received in 2027, grouped by vendor, with the Dec 28 detail", async () => {
    const s = await run((tx) => taxYearSummary(fx.deputy, tx, fx.deputy.userId, 2027));
    expect(s.year).toBe(2027);
    expect(s.payee.name).toBe("tax0");
    expect(s.byVendor).toEqual([{ vendorId: fx.vendorId, vendorName: "tax Vendor", paidCents: 42000, details: 2 }]);
    expect(s.totalPaidCents).toBe(42000);
    // Billed in 2027 and not paid: B 42000 and H 7000.
    expect(s.unpaidBilledCents).toBe(49000);
    const a = s.rows.find((r) => r.invoiceId === fx.inv.A.id)!;
    expect(a.section).toBe("paid");
    expect(a.deputyPaidAt!.getTime()).toBe(fx.inv.A.deputyPaidAt!.getTime());
    expect(a.paidDateSource).toBe("deputy");
  });

  test("yearMismatch when the vendor and deputy dates fall in different years", async () => {
    const s = await run((tx) => taxYearSummary(fx.deputy, tx, fx.deputy.userId, 2027));
    expect(s.rows.find((r) => r.invoiceId === fx.inv.A.id)!.yearMismatch).toBe(true);
    expect(s.rows.find((r) => r.invoiceId === fx.inv.C.id)!.yearMismatch).toBe(false);
  });

  test("2026: coordinator close uses the close time; written off and unpaid are listed apart; returned is not listed", async () => {
    const s = await run((tx) => taxYearSummary(fx.deputy, tx, fx.deputy.userId, 2026));
    expect(s.totalPaidCents).toBe(56000);
    expect(s.byVendor.map((v) => [v.vendorId, v.vendorName, v.paidCents, v.details])).toEqual([
      [fx.otherVendorId, "tax Other Vendor", 35000, 1],
      [fx.vendorId, "tax Vendor", 21000, 1],
    ]);
    const g = s.rows.find((r) => r.invoiceId === fx.inv.G.id)!;
    expect(g.paidDateSource).toBe("coordinator_close");
    expect(g.deputyPaidAt).toBeNull();
    expect(g.paidAt!.getTime()).toBe(at(2026, 2, 20).getTime());
    // A is billed in 2026 but received in 2027: unpaid at year end. F is written off: in neither.
    expect(s.unpaidBilledCents).toBe(28000);
    expect(s.rows.find((r) => r.invoiceId === fx.inv.A.id)!.section).toBe("unpaid");
    const f = s.rows.find((r) => r.invoiceId === fx.inv.F.id)!;
    expect(f.section).toBe("written_off");
    expect(f.status).toBe("written_off");
    expect(s.rows.some((r) => r.invoiceId === fx.inv.E.id)).toBe(false);
  });

  test("a coordinator close in January of a vendor-reported December payment counts in 2027 and is flagged", async () => {
    const person = await fx.person();
    const inv = await fx.mkInvoice({ person, start: at(2026, 12, 20, 17), minutes: 60, status: "paid", vendorPaidAt: at(2026, 12, 30), closedPaidAt: at(2027, 1, 10) });
    const s2027 = await run((tx) => taxYearSummary(fx.coord, tx, person.userId, 2027));
    const row = s2027.rows.find((r) => r.invoiceId === inv.id)!;
    expect(row.section).toBe("paid");
    expect(row.paidDateSource).toBe("coordinator_close");
    expect(row.deputyPaidAt).toBeNull();
    expect(row.paidAt!.getTime()).toBe(at(2027, 1, 10).getTime());
    expect(row.yearMismatch).toBe(true);
    expect(s2027.totalPaidCents).toBe(7000);
    const s2026 = await run((tx) => taxYearSummary(fx.coord, tx, person.userId, 2026));
    expect(s2026.totalPaidCents).toBe(0);
    expect(s2026.unpaidBilledCents).toBe(7000);

    const csv = (await run((tx) => exportTaxSummary(fx.coord, tx, person.userId, 2027, "csv"))).toString("utf8").trimEnd().split("\r\n");
    expect(csv[0]).toContain("Date counted");
    expect(csv[1]).toContain(",2027-01-10,Coordinator close,Yes");
    const pdf = await run((tx) => exportTaxSummary(fx.coord, tx, person.userId, 2027, "pdf"));
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toMatch(/Jan 10,\s*2027/);
    expect(text.replaceAll("-\n", "")).toMatch(/Closed as paid by\s*coordinator/);
  });

  test("rows run paid, unpaid, written off, each by job date then invoice number", async () => {
    const s = await run((tx) => taxYearSummary(fx.coord, tx, fx.deputy.userId, 2026));
    expect(s.rows.map((r) => [r.section, r.jobDate])).toEqual([
      ["paid", "2026-02-05"],
      ["paid", "2026-03-03"],
      ["unpaid", "2026-12-28"],
      ["written_off", "2026-07-05"],
    ]);
    const person = await fx.person();
    const late = await fx.mkInvoice({ person, start: at(2028, 3, 9, 17), minutes: 60, status: "sent" });
    const first = await fx.mkInvoice({ person, start: at(2028, 3, 9, 8), minutes: 60, status: "sent" });
    const early = await fx.mkInvoice({ person, start: at(2028, 3, 2, 17), minutes: 60, status: "sent" });
    const rows = (await run((tx) => taxYearSummary(fx.coord, tx, person.userId, 2028))).rows;
    expect(rows.map((r) => r.invoiceId)).toEqual([early.id, late.id, first.id]);
  });

  test("two vendors with the same name stay separate", async () => {
    const { db } = get();
    const [dup] = await db.insert(vendors).values({ name: "tax Vendor", defaultRateCents: 7000 }).returning();
    const person = await fx.person();
    await fx.mkInvoice({ person, vendorId: fx.vendorId, start: at(2026, 5, 1, 17), minutes: 60, status: "paid", deputyPaidAt: at(2026, 5, 9) });
    await fx.mkInvoice({ person, vendorId: dup.id, start: at(2026, 5, 2, 17), minutes: 120, status: "paid", deputyPaidAt: at(2026, 5, 9) });
    const s = await run((tx) => taxYearSummary(fx.coord, tx, person.userId, 2026));
    expect(s.byVendor).toHaveLength(2);
    expect(s.byVendor.map((v) => v.paidCents).sort((a, b) => a - b)).toEqual([7000, 14000]);
  });

  test("a deputy cannot read another deputy's summary; a coordinator can", async () => {
    await expect(run((tx) => taxYearSummary(fx.deputy2, tx, fx.deputy.userId, 2027))).rejects.toBeInstanceOf(ForbiddenError);
    const s = await run((tx) => taxYearSummary(fx.coord, tx, fx.deputy.userId, 2027));
    expect(s.totalPaidCents).toBe(42000);
  });

  test("CSV export has a header and one line per row, and is audited", async () => {
    const buf = await run((tx) => exportTaxSummary(fx.deputy, tx, fx.deputy.userId, 2027, "csv"));
    const lines = buf.toString("utf8").trimEnd().split("\r\n");
    expect(lines[0]).toContain("Invoice");
    expect(lines[0]).toContain("Year mismatch");
    expect(lines).toHaveLength(1 + 4); // A and C paid; B and H unpaid
    const rows = (await get().db.select().from(auditLog).where(eq(auditLog.action, "tax_summary.export"))).filter((a) => a.entityId === fx.deputy.userId && a.actorUserId === fx.deputy.userId);
    expect(rows).toHaveLength(1);
    expect(rows[0].actorUserId).toBe(fx.deputy.userId);
    expect(rows[0].entityId).toBe(fx.deputy.userId);
    expect(rows[0].after).toMatchObject({ year: 2027, format: "csv" });
  });

  test("PDF export carries the agency header and the payee, and a deputy cannot export another's", async () => {
    const buf = await run((tx) => exportTaxSummary(fx.coord, tx, fx.deputy.userId, 2027, "pdf"));
    expect(buf.subarray(0, 5).toString()).toBe("%PDF-");
    const parser = new PDFParse({ data: new Uint8Array(buf) });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toContain("Your Agency");
    expect(text).toContain("tax0");
    expect(text).toContain("not tax advice");
    await expect(run((tx) => exportTaxSummary(fx.deputy2, tx, fx.deputy.userId, 2027, "pdf"))).rejects.toBeInstanceOf(ForbiddenError);
    const audits = (await get().db.select().from(auditLog).where(eq(auditLog.action, "tax_summary.export"))).filter((a) => a.entityId === fx.deputy.userId);
    expect(audits).toHaveLength(2);
  });
});
