import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { setupFixture } from "../assignments/helpers";
import { assignments, auditLog, invoices, paymentMethods, users } from "@/db/schema";
import { buildInvoicePdfData, createInvoice, formatInvoiceNumber } from "@/domain/invoices/invoices";
import { updateSettings } from "@/domain/settings/settings";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { storeFile } from "@/domain/files/files";
import { createLocalStorage } from "@/lib/storage/local";
import type { Storage } from "@/lib/storage";
import { agencyInstant } from "@/domain/time/agency-time";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64",
);

describe("invoices", () => {
  const get = useTestDb();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let storage: Storage;

  beforeAll(async () => {
    fx = await setupFixture(get().db, "inv");
    storage = createLocalStorage(await mkdtemp(join(tmpdir(), "extra-duty-inv-")));
  });

  async function mkAssignment(over: Partial<typeof assignments.$inferInsert> = {}) {
    const { db } = get();
    const person = await fx.person();
    const { job, positionId } = await fx.mkJob();
    const [a] = await db
      .insert(assignments)
      .values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "billed", ...over })
      .returning();
    return { a, job, person };
  }

  test("formatInvoiceNumber pads to six digits", () => {
    expect(formatInvoiceNumber("ED-", 1)).toBe("ED-000001");
    expect(formatInvoiceNumber("X", 1234567)).toBe("X1234567");
  });

  test("createInvoice derives vendor and payee, computes the total and audits", async () => {
    const { db } = get();
    const { a, job, person } = await mkAssignment();
    const inv = await db.transaction((tx) => createInvoice(tx, { assignmentId: a.id, minutes: 360, rateCents: 7500, status: "sent" }));
    expect(inv.vendorId).toBe(job.vendorId);
    expect(inv.payeeUserId).toBe(person.userId);
    expect(inv.totalCents).toBe(45000);
    expect(inv.status).toBe("sent");
    expect(inv.revision).toBe(0);
    const rows = await db.select().from(auditLog).where(eq(auditLog.entityId, inv.id));
    expect(rows.map((r) => r.action)).toEqual(["invoice.create"]);
  });

  test("numbers are sequential and unique under concurrent creation", async () => {
    const { db } = get();
    const made = await Promise.all(Array.from({ length: 8 }, () => mkAssignment()));
    const created = await Promise.all(
      made.map(({ a }) => db.transaction((tx) => createInvoice(tx, { assignmentId: a.id, minutes: 240, rateCents: 7000, status: "pending_review" }))),
    );
    const nums = created.map((i) => i.number).sort((x, y) => x - y);
    expect(new Set(nums).size).toBe(8);
    expect(nums).toEqual(Array.from({ length: 8 }, (_, i) => nums[0] + i));
    for (const n of nums) expect(formatInvoiceNumber("ED-", n)).toMatch(/^ED-\d{6}$/);
  });

  test("buildInvoicePdfData loads the invoice, job, vendor, payee, settings and logo", async () => {
    const { db } = get();
    const logo = await db.transaction((tx) =>
      storeFile(fx.coord, tx, { kind: "attachment", filename: "logo.png", contentType: "image/png", body: PNG }, {}, storage),
    );
    await db.transaction((tx) =>
      updateSettings(fx.coord, tx, {
        invoiceNumberPrefix: "ED-",
        billingReplyToEmail: "billing@sheriff.example",
        agency: { name: "Test Sheriff's Office", sheriffName: "Jane Doe", address: "1 Courthouse Sq", phone: "850-555-0100", email: "a@b.test", website: "https://s.test", logoFileId: logo.id },
      }),
    );
    const { a, person } = await mkAssignment({
      actualStartAt: agencyInstant(2035, 3, 1, 17, 0),
      actualEndAt: agencyInstant(2035, 3, 1, 19, 0),
    });
    await db.update(users).set({ mailingAddress: "12 Oak Lane" }).where(eq(users.id, person.userId));
    const inv = await db.transaction((tx) => createInvoice(tx, { assignmentId: a.id, minutes: 240, rateCents: 7000, status: "sent" }));
    const d = await db.transaction((tx) => buildInvoicePdfData(tx, inv.id, storage));
    expect(d.number).toBe(`ED-${String(inv.number).padStart(6, "0")}`);
    expect(d.revision).toBe(0);
    expect(d.workedMinutes).toBe(120);
    expect(d.minutes).toBe(240);
    expect(d.minimumMinutes).toBe(240);
    expect(d.rateCents).toBe(7000);
    expect(d.totalCents).toBe(28000);
    expect(d.vendor.name).toBe("inv Vendor");
    expect(d.job.title).toBe("Stadium security");
    expect(d.payee.mailingAddress).toBe("12 Oak Lane");
    expect(d.payee.email).toBe(`${(await db.select().from(users).where(eq(users.id, person.userId)))[0].email}`);
    expect(d.agency.name).toBe("Test Sheriff's Office");
    expect(d.agency.logo?.mimeType).toBe("image/png");
    expect(d.agency.logo?.bytes.equals(PNG)).toBe(true);
    expect(d.replyTo).toBe("billing@sheriff.example");
    expect(d.paid).toBeNull();
  });

  test("buildInvoicePdfData reports payment details once paid", async () => {
    const { db } = get();
    const { a } = await mkAssignment();
    const inv = await db.transaction((tx) => createInvoice(tx, { assignmentId: a.id, minutes: 240, rateCents: 7000, status: "paid" }));
    const [m] = await db.insert(paymentMethods).values({ name: "Check" }).returning();
    const at = new Date("2035-03-10T15:00:00Z");
    await db.update(invoices).set({ vendorPaidAt: at, vendorPaidMethodId: m.id, vendorPaidReference: "CHK-1" }).where(eq(invoices.id, inv.id));
    const d = await db.transaction((tx) => buildInvoicePdfData(tx, inv.id, storage));
    expect(d.paid).toEqual({ method: "Check", reference: "CHK-1", paidAt: at });
  });

  test("a logo file that is not a PNG or JPEG is ignored and the invoice still renders", async () => {
    const { db } = get();
    const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("not a logo ".repeat(10))]);
    const file = await db.transaction((tx) =>
      storeFile(fx.coord, tx, { kind: "attachment", filename: "logo.pdf", contentType: "application/pdf", body: pdf }, {}, storage),
    );
    await db.transaction((tx) =>
      updateSettings(fx.coord, tx, {
        agency: { name: "Test Sheriff's Office", sheriffName: "", address: "", phone: "", email: "a@b.test", website: "", logoFileId: file.id },
        billingReplyToEmail: "",
      }),
    );
    const { a } = await mkAssignment();
    const inv = await db.transaction((tx) => createInvoice(tx, { assignmentId: a.id, minutes: 240, rateCents: 7000, status: "sent" }));
    const d = await db.transaction((tx) => buildInvoicePdfData(tx, inv.id, storage));
    expect(d.agency.logo).toBeNull();
    expect(d.replyTo).toBe("a@b.test");
    const out = await renderInvoicePdf(d);
    expect(out.includes(Buffer.from("/Subtype /Image"))).toBe(false);
  });
});
