import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import { useTestDb } from "../../setup/test-db";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, invoices, w9s } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { parseAuditQuery, searchAudit, type AuditQuery } from "@/domain/audit/search";
import { CSV_HEADER, countSelection, exportAuditCsv, integrityCode, printAuditRecord, verifyAuditRecord } from "@/domain/audit/records";
import { AUDIT_STATEMENT } from "@/lib/pdf/audit-record-pdf";

const NOW = new Date("2035-06-15T17:00:00Z");

async function text(stream: ReadableStream<Uint8Array>): Promise<string> {
  return new Response(stream).text();
}

describe("audit log filters, exports and records", () => {
  const get = useTestDb();
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let pat: Actor;
  let other: Actor;
  let jobNumber: number;
  let invoiceNumber: number;
  const ids: Record<string, string> = {};

  const add = async (key: string, v: Partial<typeof auditLog.$inferInsert> & { action: string; entityType: string }) => {
    const [r] = await get().db.insert(auditLog).values({ at: new Date("2035-06-10T15:00:00Z"), ...v }).returning();
    ids[key] = r.id;
    return r;
  };
  const found = async (q: AuditQuery) => (await f.run((tx) => searchAudit(f.coord, tx, q, 1, NOW))).rows.map((r) => r.id);

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "auditx");
    admin = (await makeUser(db, "admin", "auditx-admin@example.test", { name: "Alex Admin" })).actor;
    pat = await f.person();
    other = await f.person();
    const { job, positionId } = await f.mkJob();
    jobNumber = job.number;
    const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: pat.userId, status: "billed" }).returning();
    const [inv] = await db.insert(invoices).values({ assignmentId: a.id, vendorId: f.vendorId, payeeUserId: pat.userId, minutes: 360, rateCents: 7000, totalCents: 42000, status: "sent" }).returning();
    invoiceNumber = inv.number;
    const [w9] = await db.select().from(w9s).where(eq(w9s.userId, pat.userId));
    // Only this test's own entries: the fixture's setup wrote some of its own.
    await db.delete(auditLog);

    await add("suspend", { actorUserId: f.coord.userId, action: "user.suspend", entityType: "user", entityId: pat.userId, before: { suspendedUntil: null }, after: { suspendedUntil: "2035-07-01" }, reason: "Missed two details" });
    await add("remove", { actorUserId: f.coord.userId, action: "assignment.assign", entityType: "assignment", entityId: a.id, after: { status: "signed_up" } });
    await add("w9", { actorUserId: admin.userId, action: "w9.approve", entityType: "w9", entityId: w9.id, before: { status: "pending" }, after: { status: "approved", tin: "123-45-6789", signedOn: "2035-01-02" } });
    await add("job", { actorUserId: f.coord.userId, action: "job.update", entityType: "job", entityId: job.id, before: { rateCents: 6500 }, after: { rateCents: 7000 }, reason: "=cmd|' /C calc'!A0" });
    await add("invoice", { actorUserId: pat.userId, action: "invoice.send", entityType: "invoice", entityId: inv.id, after: { status: "sent" } });
    await add("system", { actorUserId: null, action: "jobs.release_recompute", entityType: "jobs", entityId: "all", after: { count: 3 } });
    await add("old", { actorUserId: other.userId, action: "user.contact_update", entityType: "user", entityId: other.userId, at: new Date("2034-03-01T15:00:00Z"), before: { phone: "555-0100", passwordHash: "hash-before-zzz" }, after: { phone: "555-0101", passwordHash: "hash-after-zzz", apiKeySecret: "ed_live_xyz" } });
  });

  test("Done by finds every action a person performed", async () => {
    const r = await found({ doneBy: admin.userId });
    expect(r).toEqual([ids.w9]);
  });

  test("About finds every entry where the person is the subject: account, sign-ups, W-9 and invoices", async () => {
    const r = await found({ about: pat.userId });
    expect(new Set(r)).toEqual(new Set([ids.suspend, ids.remove, ids.w9, ids.invoice]));
  });

  test("action types filter in plain-word groups, more than one at once", async () => {
    expect(await found({ groups: ["w9"] })).toEqual([ids.w9]);
    expect(new Set(await found({ groups: ["w9", "billing"] }))).toEqual(new Set([ids.w9, ids.invoice]));
  });

  test("detail number, vendor and invoice number", async () => {
    expect(new Set(await found({ detail: jobNumber }))).toEqual(new Set([ids.remove, ids.job, ids.invoice]));
    expect(await found({ detail: 999_999 })).toEqual([]);
    expect(new Set(await found({ vendorId: f.vendorId }))).toEqual(new Set([ids.job, ids.invoice]));
    expect(await found({ invoice: invoiceNumber })).toEqual([ids.invoice]);
  });

  test("date range presets and a custom range, in agency time", async () => {
    const recent = await found({ preset: "30d" });
    expect(recent).toContain(ids.suspend);
    expect(recent).not.toContain(ids.old);
    expect(await found({ preset: "custom", from: "2034-02-28", to: "2034-03-01" })).toEqual([ids.old]);
    expect((await found({ preset: "year" })).includes(ids.old)).toBe(false);
  });

  test("text search covers the reason and the plain-word summary", async () => {
    expect(await found({ text: "missed two" })).toEqual([ids.suspend]);
    expect(await found({ text: "Release dates recalculated" })).toEqual([ids.system]);
  });

  test("system actions can be left out, and oldest first reverses the order", async () => {
    expect(await found({ system: false })).not.toContain(ids.system);
    const newest = await found({});
    const oldest = await found({ order: "oldest" });
    expect(oldest[0]).toBe(ids.old);
    expect(newest.at(-1)).toBe(ids.old);
  });

  test("the address bar query parses every filter", () => {
    expect(parseAuditQuery({ by: pat.userId, group: ["w9", "bogus", "payments"], detail: "#12", invoice: "ED-000042", range: "7d", q: " lock ", system: "0", order: "oldest" })).toEqual({
      doneBy: pat.userId,
      groups: ["w9", "payments"],
      detail: 12,
      invoice: 42,
      preset: "7d",
      text: "lock",
      system: false,
      order: "oldest",
    });
  });

  test("select all matching covers every matching entry, not only the page", async () => {
    expect(await f.run((tx) => countSelection(f.coord, tx, { query: {} }, NOW))).toBe(7);
    expect(await f.run((tx) => countSelection(f.coord, tx, { query: {}, ids: [ids.w9, ids.job] }, NOW))).toBe(2);
  });

  test("only coordinators and admins read or export it", async () => {
    await expect(f.run((tx) => searchAudit(pat, tx, {}, 1, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(exportAuditCsv(pat, (fn) => get().db.transaction(fn), { query: {} }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("CSV: the columns, agency time with the zone, readable changes, the formula guard, secrets left out, and the export audited", async () => {
    const { stream, count } = await exportAuditCsv(f.coord, (fn) => get().db.transaction(fn), { query: { about: pat.userId } }, NOW);
    expect(count).toBe(4);
    const csv = await text(stream);
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe(CSV_HEADER.join(","));
    expect(lines).toHaveLength(5);
    expect(csv).toContain(`${ids.suspend},"Jun 10, 2035, 10:00 AM CDT"`);
    expect(csv).toContain("Suspended until: none to 2035-07-01");
    expect(csv).toContain("W-9 approved");
    expect(csv).not.toContain("123-45-6789");

    const all = await text((await exportAuditCsv(f.coord, (fn) => get().db.transaction(fn), { query: {} }, NOW)).stream);
    expect(all).toContain(",'=cmd|' /C calc'!A0,");
    expect(all).not.toContain("ed_live_xyz");
    expect(all).not.toContain("hash-after-zzz");
    expect(all).toContain("System,,");

    const [audit] = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "audit.export"), eq(auditLog.actorUserId, f.coord.userId)));
    expect(audit.after).toMatchObject({ format: "csv", entries: 4, filters: expect.arrayContaining([expect.stringMatching(/^About: /)]) });
  });

  test("CSV streams a large export in batches", async () => {
    await get().db.insert(auditLog).values(Array.from({ length: 1200 }, (_, i) => ({ actorUserId: other.userId, action: "user.theme_set", entityType: "user", entityId: other.userId, after: { theme: i % 2 ? "night" : "day" }, at: new Date(Date.UTC(2035, 5, 1, 0, i)) })));
    const { stream, count } = await exportAuditCsv(f.coord, (fn) => get().db.transaction(fn), { query: { groups: ["users"], doneBy: other.userId } }, NOW);
    expect(count).toBe(1201);
    expect((await text(stream)).trim().split("\r\n")).toHaveLength(1202);
  });

  test("PDF: cover, entries, page numbering, the integrity code, secrets redacted, and the print audited", async () => {
    const r = await f.run((tx) => printAuditRecord(f.coord, tx, { query: { about: pat.userId } }, { now: NOW }));
    expect(r.recordId).toMatch(/^AR-\d{6}$/);
    expect(r.integrity).toMatch(/^[0-9a-f]{64}$/);
    const parsed = new PDFParse({ data: new Uint8Array(r.pdf) });
    const { text: t, total } = await parsed.getText();
    for (const s of ["Audit Record", `Record ID`, r.recordId, "Number of entries", "Generated by", "Generated at", `About: `, "Prepared by", "Reviewed by", "Signature", "Done by", "Reason", "Missed two details", "System context", "Suspended until"]) {
      expect(t).toContain(s);
    }
    expect(t.replace(/\s+/g, " ")).toContain(AUDIT_STATEMENT);
    expect(t).toContain(`Page 1 of ${total}`);
    expect(t).toContain(`Integrity ${r.integrity}`);
    expect(t).not.toContain("123-45-6789");

    const rows = await get().db.select().from(auditLog).where(eq(auditLog.action, "audit.print"));
    expect(rows.at(-1)?.after).toMatchObject({ format: "pdf", record: r.recordId, entries: 4, integrity: r.integrity });
  });

  test("a single entry prints with the same layout", async () => {
    const r = await f.run((tx) => printAuditRecord(f.coord, tx, { query: {}, ids: [ids.job] }, { now: NOW }));
    expect(r.count).toBe(1);
    const { text: t } = await new PDFParse({ data: new Uint8Array(r.pdf) }).getText();
    expect(t).toContain("Number of entries");
    expect(t).toContain("Rate cents");
  });

  test("a large print asks for confirmation", async () => {
    await get().db.insert(auditLog).values(Array.from({ length: 900 }, () => ({ actorUserId: other.userId, action: "user.maps_app_set", entityType: "user", entityId: other.userId })));
    await expect(f.run((tx) => printAuditRecord(f.coord, tx, { query: { doneBy: other.userId } }, { now: NOW }))).rejects.toThrow(/2,101 entries. Narrow the filters, or confirm/);
  }, 120_000);

  test("verification: a record matches until its data changes, and a pasted code is compared", async () => {
    const r = await f.run((tx) => printAuditRecord(f.coord, tx, { query: { doneBy: admin.userId } }, { now: NOW }));
    const ok = await f.run((tx) => verifyAuditRecord(admin, tx, { recordId: r.recordId, integrity: r.integrity.toUpperCase() }));
    expect(ok).toMatchObject({ recordId: r.recordId, matches: true, printedMatches: true, missing: 0, entryCount: 1 });
    expect((await f.run((tx) => verifyAuditRecord(admin, tx, { recordId: r.recordId.replace("AR-", "ar "), integrity: "0".repeat(64) }))).printedMatches).toBe(false);
    await expect(f.run((tx) => verifyAuditRecord(f.coord, tx, { recordId: r.recordId }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => verifyAuditRecord(admin, tx, { recordId: "nonsense" }))).rejects.toBeInstanceOf(ValidationError);

    // Changed behind the application's back: the record no longer matches.
    await get().db.update(auditLog).set({ reason: "edited" }).where(eq(auditLog.id, ids.w9));
    const bad = await f.run((tx) => verifyAuditRecord(admin, tx, { recordId: r.recordId, integrity: r.integrity }));
    expect(bad.matches).toBe(false);
    expect(bad.printedMatches).toBe(true);
    expect(bad.current).not.toBe(r.integrity);
  });

  test("the integrity code is stable for the same data and changes with any field", () => {
    const row = { id: "a", at: new Date("2035-01-01T00:00:00Z"), actorUserId: null, action: "x.y", entityType: "x", entityId: "1", before: { b: 1, a: 2 }, after: null, reason: null };
    expect(integrityCode([row])).toBe(integrityCode([{ ...row, before: { a: 2, b: 1 } }]));
    expect(integrityCode([row])).not.toBe(integrityCode([{ ...row, reason: "r" }]));
  });
});
