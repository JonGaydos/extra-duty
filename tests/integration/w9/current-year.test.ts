import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { assignments, invoices, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { createInvoice } from "@/domain/invoices/invoices";
import { agencyInstant } from "@/domain/time/agency-time";
import { updateVendor } from "@/domain/vendors/vendors";
import { attachableW9, currentYearNotice, readW9ForInvoiceEmail, reviewW9, uploadW9, vendorW9Gaps } from "@/domain/w9/w9";
import { createLocalStorage } from "@/lib/storage/local";
import type { Storage } from "@/lib/storage";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("this year ".repeat(20))]);
const NOW = agencyInstant(2026, 11, 27, 10, 0);

describe("a vendor that requires a W-9 signed this year", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let storage: Storage;
  let payee: Actor;

  const invoiceFor = async (who: Actor) => {
    const { job, positionId } = await f.mkJob();
    const [a] = await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: who.userId, status: "billed" }).returning();
    const inv = await get().db.transaction((tx) => createInvoice(tx, { assignmentId: a.id, minutes: 240, rateCents: 7000, status: "pending_review" }));
    await get().db.update(invoices).set({ attachW9: true }).where(eq(invoices.id, inv.id));
    return inv;
  };

  beforeAll(async () => {
    f = await setupFixture(get().db, "thisyear");
    storage = createLocalStorage(await mkdtemp(join(tmpdir(), "extra-duty-w9-year-")));
    payee = await f.person("Deputy Sheriff", { w9: false });
    const row = await get().db.transaction((tx) => uploadW9(payee, tx, PDF, "w9.pdf", storage));
    await get().db.transaction((tx) => reviewW9(f.coord, tx, row.id, { decision: "approve", signedOn: "2025-12-01", formRevision: "March 2024" }, NOW));
  });

  test("staff turn the setting on; it is off by default", async () => {
    const [before] = await get().db.select().from(vendors).where(eq(vendors.id, f.vendorId));
    expect(before.requiresCurrentYearW9).toBe(false);
    const after = await get().db.transaction((tx) => updateVendor(f.coord, tx, f.vendorId, { requiresCurrentYearW9: true }));
    expect(after.requiresCurrentYearW9).toBe(true);
  });

  test("an older W-9 is not attached to that vendor's invoice, and the notice says why", async () => {
    const inv = await invoiceFor(payee);
    expect(await get().db.transaction((tx) => readW9ForInvoiceEmail(tx, inv.id, storage, undefined, NOW))).toBeNull();
    const a = await get().db.transaction((tx) => attachableW9(tx, payee.userId, f.vendorId, NOW));
    expect(a.problem).toBe("not_current_year");
    expect(currentYearNotice(a, "Your", NOW)).toBe(
      "This vendor needs a W-9 signed in 2026. Your approved W-9 was signed Dec 1, 2025, so it will not be attached. Upload a new W-9 to fix this.",
    );
    // Other vendors still get it.
    expect((await get().db.transaction((tx) => attachableW9(tx, payee.userId, f.otherVendorId, NOW))).problem).toBeNull();
  });

  test("the vendor page lists the payee until a W-9 signed this year is approved; billing is never blocked", async () => {
    expect((await get().db.transaction((tx) => vendorW9Gaps(f.coord, tx, f.vendorId, NOW))).map((g) => g.userId)).toEqual([payee.userId]);
    const row = await get().db.transaction((tx) => uploadW9(payee, tx, PDF, "w9.pdf", storage));
    await get().db.transaction((tx) => reviewW9(f.coord, tx, row.id, { decision: "approve", signedOn: "2026-11-20", formRevision: "March 2024" }, NOW));
    expect(await get().db.transaction((tx) => vendorW9Gaps(f.coord, tx, f.vendorId, NOW))).toEqual([]);
    const inv = await invoiceFor(payee);
    const w9 = await get().db.transaction((tx) => readW9ForInvoiceEmail(tx, inv.id, storage, undefined, NOW));
    expect(w9?.body.equals(PDF)).toBe(true);
  });
});
