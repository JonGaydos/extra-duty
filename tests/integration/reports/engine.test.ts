import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, gte, isNull, lte, sql } from "drizzle-orm";
import { PDFParse } from "pdf-parse";
import { useTestDb } from "../../setup/test-db";
import { assignments, auditLog, billingLockOverrides, invoices, jobChangeRequests, jobs, messages, opsPlans, paymentIssues, savedReports, seasons, users, vendorHolds } from "@/db/schema";
import { seed } from "@/db/seed";
import { recordAudit } from "@/domain/audit/audit";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { exportReport, runReport, type ReportSpec } from "@/domain/reports/engine";
import { BUILT_IN_REPORTS, deleteSavedReport, listSavedReports, runSavedReport, saveReport } from "@/domain/reports/saved";
import { agencyInstant } from "@/domain/time/agency-time";
import { makeUser } from "../users/helpers";
import { at, buildFixture, NOW } from "./helpers";

const FROM = at(2026, 1, 1, 0);
const TO = at(2027, 12, 31, 23);
const base = (o: Partial<ReportSpec> = {}): ReportSpec => ({
  dataset: "invoices",
  from: FROM,
  to: TO,
  filters: {},
  groupBy: [],
  measures: ["count"],
  ...o,
});

describe("report engine", () => {
  const get = useTestDb();
  let fx: Awaited<ReturnType<typeof buildFixture>>;
  const run = <T>(fn: Parameters<ReturnType<typeof get>["db"]["transaction"]>[0] extends (tx: infer X) => unknown ? (tx: X) => Promise<T> : never) => get().db.transaction(fn);

  beforeAll(async () => {
    fx = await buildFixture(get().db, "eng");
  });

  test("invoices grouped by month and deputy with billed_cents matches the fixture", async () => {
    const r = await run((tx) => runReport(fx.coord, tx, base({ groupBy: ["month", "deputy"], measures: ["billed_cents"] }), NOW));
    expect(r.columns).toEqual(["month", "deputy", "billed_cents"]);
    const cell = (month: string, name: string) => r.rows.find((row) => row[0] === month && row[1] === name)?.[2];
    expect(cell("2026-12", "eng0")).toBe(28000);
    expect(cell("2027-01", "eng0")).toBe(63000);
    expect(cell("2026-03", "eng0")).toBe(35000);
    expect(cell("2026-02", "eng0")).toBe(21000);
    expect(cell("2026-12", "eng1")).toBe(7000);
    // Returned (E) and written off (F) are listed but never billed.
    expect(cell("2026-06", "eng0")).toBe(0);
    expect(cell("2026-07", "eng0")).toBe(0);
    // A, B, C, D, G, H, I, J billed: 28000+42000+14000+35000+21000+7000+14000+7000.
    expect(r.totals.billed_cents).toBe(168000);
  });

  test("agency time: a 11:30 PM Central detail on Nov 30 groups in November and on Nov 30", async () => {
    const m = await run((tx) => runReport(fx.coord, tx, base({ groupBy: ["month"], measures: ["billed_cents"] }), NOW));
    expect(m.rows.find((row) => row[0] === "2026-11")?.[1]).toBe(14000);
    expect(m.rows.find((row) => row[0] === "2026-12")?.[1]).toBe(35000);
    const d = await run((tx) => runReport(fx.coord, tx, base({ groupBy: ["day"], measures: ["billed_cents"] }), NOW));
    expect(d.rows.find((row) => row[0] === "2026-11-30")?.[1]).toBe(14000);
    expect(d.rows.some((row) => row[0] === "2026-12-01")).toBe(false);
  });

  test("paid, outstanding, count, hours and the year and status groupings", async () => {
    const r = await run((tx) =>
      runReport(fx.coord, tx, base({ groupBy: ["year"], measures: ["count", "hours", "billed_cents", "paid_cents", "outstanding_cents"] }), NOW),
    );
    const y2027 = r.rows.find((row) => row[0] === "2027")!;
    // 2027: B, C, H billed (63000), C paid (14000) and A paid in January but billed in 2026; outstanding B + H.
    expect(y2027.slice(1)).toEqual([3, 9, 63000, 14000, 49000]);
    const status = await run((tx) => runReport(fx.coord, tx, base({ groupBy: ["status"], measures: ["count"] }), NOW));
    expect(Object.fromEntries(status.rows.map((row) => [row[0], row[1]]))).toEqual({ paid: 5, sent: 2, pending_review: 1, returned: 1, written_off: 1 });
  });

  test("filters narrow by deputy, vendor and status", async () => {
    const r = await run((tx) =>
      runReport(fx.coord, tx, base({ filters: { userIds: [fx.deputy2.userId], vendorIds: [fx.otherVendorId] }, measures: ["count", "billed_cents"] }), NOW),
    );
    expect(r.totals).toEqual({ count: 1, billed_cents: 7000 });
    const s = await run((tx) => runReport(fx.coord, tx, base({ filters: { statuses: ["sent"] }, measures: ["count"] }), NOW));
    expect(s.totals.count).toBe(2);
  });

  test("unpaid by responsible party and age bucket", async () => {
    const { db } = get();
    await db.update(invoices).set({ responsibleParty: "vendor" }).where(eq(invoices.id, fx.inv.B.id));
    await db.update(invoices).set({ responsibleParty: "coordinator", createdAt: at(2027, 1, 14) }).where(eq(invoices.id, fx.inv.H.id));
    await db.update(invoices).set({ responsibleParty: "deputy" }).where(eq(invoices.id, fx.inv.I.id));
    const r = await run((tx) =>
      runReport(fx.coord, tx, base({ filters: { statuses: ["sent", "pending_review"] }, groupBy: ["responsible_party", "age_bucket"], measures: ["count", "outstanding_cents"] }), NOW),
    );
    // Age counts from the sent date (created, if unsent): B 8 days, H 6 days, I 49 days.
    expect(r.rows).toEqual([
      ["coordinator", "0-30", 1, 7000],
      ["deputy", "31-60", 1, 14000],
      ["vendor", "0-30", 1, 42000],
    ]);
  });

  test("count covers every invoice while billed_count, hours and money cover billed ones", async () => {
    const r = await run((tx) => runReport(fx.coord, tx, base({ measures: ["count", "billed_count", "hours"] }), NOW));
    expect(r.totals.count).toBe(10);
    expect(r.totals.billed_count).toBe(8);
    expect(r.totals.hours).toBe(24);
  });

  test("date-only from and to are agency days", async () => {
    const spec = { ...base({ groupBy: ["day"], measures: ["billed_cents"] }), from: "2026-11-30", to: "2026-11-30" } as unknown as ReportSpec;
    const r = await run((tx) => runReport(fx.coord, tx, spec, NOW));
    expect(r.rows).toEqual([["2026-11-30", 14000]]);
  });

  test("a CSV export with date-only from and to (as the pages post them) covers whole agency days", async () => {
    // I starts 11:30 PM Central on Nov 30, already Dec 1 in UTC: it belongs to Nov 30 and to no other day.
    const spec = (from: string, to: string) => ({ ...base({ groupBy: ["day"], measures: ["billed_cents"] }), from, to }) as unknown as ReportSpec;
    const csv = (await run((tx) => exportReport(fx.coord, tx, spec("2026-11-01", "2026-11-30"), "csv", { now: NOW }))).toString("utf8");
    expect(csv).toContain("2026-11-30,140.00");
    const dec = (await run((tx) => exportReport(fx.coord, tx, spec("2026-12-01", "2026-12-01"), "csv", { now: NOW }))).toString("utf8");
    expect(dec.trim().split(/\r?\n/)).toHaveLength(1);
  });

  test("unsupported groupings, measures, filters and datasets throw ValidationError", async () => {
    await expect(run((tx) => runReport(fx.coord, tx, base({ dataset: "messages", groupBy: ["vendor"] })))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => runReport(fx.coord, tx, base({ dataset: "audit", measures: ["hours"] })))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => runReport(fx.coord, tx, base({ dataset: "ops_plans", filters: { userIds: ["x"] } })))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => runReport(fx.coord, tx, { ...base(), dataset: "bogus" as never }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => runReport(fx.coord, tx, { ...base(), groupBy: ["price" as never] }))).rejects.toBeInstanceOf(ValidationError);
  });

  test("personnel and vendors cannot run agency reports", async () => {
    await expect(run((tx) => runReport(fx.deputy, tx, base()))).rejects.toBeInstanceOf(ForbiddenError);
    const vendor = { ...(await makeUser(get().db, "vendor", "eng-v@example.test")).actor, vendorId: fx.vendorId };
    await expect(run((tx) => runReport(vendor, tx, base()))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => exportReport(fx.deputy, tx, base(), "csv"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("range limits: required, ordered, at most 5 years", async () => {
    await expect(run((tx) => runReport(fx.coord, tx, { ...base(), from: undefined as never }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => runReport(fx.coord, tx, base({ from: TO, to: FROM })))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => runReport(fx.coord, tx, base({ from: at(2020, 1, 1), to: at(2026, 1, 2) })))).rejects.toThrow(/5 years/);
    await run((tx) => runReport(fx.coord, tx, base({ from: at(2021, 1, 1), to: at(2026, 1, 1) })));
  });

  test("payments, jobs, assignments and the other datasets run", async () => {
    const pay = await run((tx) => runReport(fx.coord, tx, base({ dataset: "payments", groupBy: ["month"], measures: ["paid_cents", "count"] }), NOW));
    // Paid by received date: Jan 2027 holds A and C.
    expect(pay.rows.find((row) => row[0] === "2027-01")).toEqual(["2027-01", 42000, 2]);
    expect(pay.rows.find((row) => row[0] === "2026-02")).toEqual(["2026-02", 21000, 1]);
    const jobs = await run((tx) => runReport(fx.coord, tx, base({ dataset: "jobs", groupBy: ["vendor"], measures: ["count", "hours"] }), NOW));
    expect(jobs.totals.count).toBe(10);
    const asg = await run((tx) => runReport(fx.coord, tx, base({ dataset: "assignments", groupBy: ["status"], measures: ["count"] }), NOW));
    expect(asg.totals.count).toBe(10);
  });

  test("messages report counts and metadata only, never bodies", async () => {
    const { db } = get();
    await db.insert(messages).values({ senderUserId: fx.coord.userId, subject: "TOPSECRETSUBJECT", body: "TOPSECRETBODY", sentAt: at(2026, 5, 5), recipientCount: 7 });
    const spec = base({ dataset: "messages", groupBy: ["month", "deputy"], measures: ["count", "recipients"] });
    const r = await run((tx) => runReport(fx.coord, tx, spec, NOW));
    expect(r.rows).toEqual([["2026-05", "eng-coord", 1, 7]]);
    const csv = (await run((tx) => exportReport(fx.coord, tx, spec, "csv"))).toString("utf8");
    expect(csv).not.toContain("TOPSECRET");
    expect(JSON.stringify(r)).not.toContain("TOPSECRET");
  });

  test("audit dataset counts every recorded action by day and never exposes before or after", async () => {
    const { db } = get();
    await run((tx) => recordAudit(tx, { actor: fx.coord, action: "user.update", entityType: "user", entityId: "u1", before: { password: "hunter2" }, after: { apiKey: "SECRETKEY" } }));
    await db.insert(auditLog).values([
      { actorUserId: fx.coord.userId, action: "x.late", entityType: "thing", entityId: "1", at: at(2026, 4, 30, 23, 45), after: { token: "SECRETTOKEN" } },
      { actorUserId: fx.coord.userId, action: "x.early", entityType: "thing", entityId: "2", at: at(2026, 5, 1, 0, 15) },
    ]);
    const wide = base({ dataset: "audit", from: at(2026, 1, 1, 0), to: new Date(NOW.getTime() + 365 * 86_400_000), groupBy: ["day"], measures: ["count"] });
    const r = await run((tx) => runReport(fx.coord, tx, wide, NOW));
    const [{ n }] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(auditLog)
      .where(and(gte(auditLog.at, wide.from), lte(auditLog.at, wide.to)));
    expect(r.totals.count).toBe(n);
    expect(r.rows.find((row) => row[0] === "2026-04-30")?.[1]).toBe(1);
    expect(r.rows.find((row) => row[0] === "2026-05-01")?.[1]).toBe(1);
    const byAction = await run((tx) => runReport(fx.coord, tx, { ...wide, groupBy: ["action", "entity_type"] }, NOW));
    expect(byAction.rows.some((row) => row[0] === "x.late" && row[1] === "thing")).toBe(true);
    const csv = (await run((tx) => exportReport(fx.coord, tx, { ...wide, groupBy: ["action", "entity_type", "deputy"] }, "csv"))).toString("utf8");
    expect(csv).not.toMatch(/hunter2|SECRETKEY|SECRETTOKEN/);
  });

  test("CSV export has a header row, guards formulas and is audited; PDF carries the agency name", async () => {
    const { db } = get();
    await db.update(users).set({ name: "=HYPERLINK(1)" }).where(eq(users.id, fx.deputy2.userId));
    const spec = base({ groupBy: ["deputy"], measures: ["count", "billed_cents"] });
    const csv = (await run((tx) => exportReport(fx.coord, tx, spec, "csv"))).toString("utf8");
    const lines = csv.trimEnd().split("\r\n");
    expect(lines[0]).toBe("Deputy,Count,Billed ($)");
    expect(lines).toContain("'=HYPERLINK(1),2,210.00");
    await db.update(users).set({ name: "eng1" }).where(eq(users.id, fx.deputy2.userId));

    const pdf = await run((tx) => exportReport(fx.coord, tx, spec, "pdf"));
    expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    const text = (await parser.getText()).text;
    await parser.destroy();
    expect(text).toContain("Your Agency");
    expect(text).toContain("Invoices");
    expect(text).toContain("2026-01-01");
    expect(text).toContain("$1,680.00");

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "report.export"));
    expect(audits.length).toBeGreaterThanOrEqual(2);
    expect(audits.every((a) => a.actorUserId === fx.coord.userId)).toBe(true);
    const afters = audits.map((a) => a.after as { dataset: string; format: string });
    expect(afters).toContainEqual(expect.objectContaining({ dataset: "invoices", format: "csv" }));
    expect(afters).toContainEqual(expect.objectContaining({ dataset: "invoices", format: "pdf" }));
  });

  test("a long table paginates", async () => {
    const spec = base({ dataset: "audit", from: at(2026, 1, 1, 0), to: new Date(NOW.getTime() + 365 * 86_400_000), groupBy: ["action", "entity_type"] });
    const { db } = get();
    await db.insert(auditLog).values(Array.from({ length: 120 }, (_, i) => ({ actorUserId: fx.coord.userId, action: `bulk.action${i}`, entityType: "bulk", entityId: String(i), at: at(2026, 6, 1) })));
    const pdf = await run((tx) => exportReport(fx.coord, tx, spec, "pdf"));
    const parser = new PDFParse({ data: new Uint8Array(pdf) });
    const info = await parser.getInfo();
    await parser.destroy();
    expect(info.total).toBeGreaterThan(1);
  });

  describe("saved reports", () => {
    test("built-ins are seeded idempotently and listed for coordinators", async () => {
      const { db } = get();
      await seed(db);
      await seed(db);
      const builtIns = await db.select().from(savedReports).where(and(eq(savedReports.builtIn, true), isNull(savedReports.deletedAt)));
      expect(builtIns).toHaveLength(BUILT_IN_REPORTS.length);
      expect(builtIns.every((b) => b.ownerUserId === null)).toBe(true);
      const names = (await run((tx) => listSavedReports(fx.coord, tx))).map((r) => r.name);
      for (const n of [
        "Agency billed by detail date, by day",
        "Agency billed by detail date, by month",
        "Agency billed by detail date, by year",
        "Agency paid by date received, by day",
        "Agency paid by date received, by month",
        "Agency paid by date received, by year",
        "Earnings by deputy for a period",
        "Billing by vendor",
        "Unpaid invoices by responsible party and age",
        "Cancellations, late cancellations and no shows by deputy",
        "Fill rate by month (filled versus expired)",
        "Hours by deputy against caps",
        "Ops plans by status",
      ]) {
        expect(names).toContain(n);
      }
      await expect(run((tx) => listSavedReports(fx.deputy, tx))).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a reseed brings stored built-in definitions up to date and leaves people's own reports alone", async () => {
      const { db } = get();
      await seed(db);
      // A database seeded before a built-in changed: Personnel activity without the newer column, Unpaid invoices with an old filter.
      const activity = BUILT_IN_REPORTS.find((r) => r.name === "Personnel activity")!;
      const unpaid = BUILT_IN_REPORTS.find((r) => r.name.startsWith("Unpaid invoices"))!;
      const oldActivity = { ...activity.spec, measures: activity.spec.measures.filter((m) => m !== "suspension_removals") };
      const oldUnpaid = { ...unpaid.spec, filters: { statuses: ["sent"] } };
      await db.update(savedReports).set({ spec: oldActivity }).where(and(eq(savedReports.builtIn, true), eq(savedReports.name, activity.name)));
      await db.update(savedReports).set({ spec: oldUnpaid }).where(and(eq(savedReports.builtIn, true), eq(savedReports.name, unpaid.name)));
      const mine = await run((tx) => saveReport(fx.coord, tx, "Personnel activity", { ...oldActivity, from: undefined, to: undefined }));
      const auditsBefore = (await db.select().from(auditLog).where(eq(auditLog.action, "saved_report.builtin_update"))).length;

      await seed(db);

      const stored = await db.select().from(savedReports).where(and(eq(savedReports.builtIn, true), isNull(savedReports.deletedAt)));
      expect(stored).toHaveLength(BUILT_IN_REPORTS.length);
      for (const r of BUILT_IN_REPORTS) expect(stored.find((s) => s.name === r.name)?.spec).toEqual(JSON.parse(JSON.stringify(r.spec)));
      expect((stored.find((s) => s.name === activity.name)!.spec as { measures: string[] }).measures).toContain("suspension_removals");
      const [own] = await db.select().from(savedReports).where(eq(savedReports.id, mine.id));
      expect((own.spec as { measures: string[] }).measures).not.toContain("suspension_removals");
      // Two definitions changed, so two system audit rows; a further reseed changes nothing.
      expect((await db.select().from(auditLog).where(eq(auditLog.action, "saved_report.builtin_update"))).length).toBe(auditsBefore + 2);
      await seed(db);
      expect((await db.select().from(auditLog).where(eq(auditLog.action, "saved_report.builtin_update"))).length).toBe(auditsBefore + 2);
    });

    test("every built-in runs against a period", async () => {
      const list = await run((tx) => listSavedReports(fx.coord, tx));
      for (const r of list.filter((x) => x.builtIn)) {
        const out = await run((tx) => runSavedReport(fx.coord, tx, r.id, { from: FROM, to: TO }, NOW));
        expect(out.columns.length).toBeGreaterThan(0);
      }
    });

    test("fill rate counts filled and expired jobs by month", async () => {
      const list = await run((tx) => listSavedReports(fx.coord, tx));
      const fill = list.find((r) => r.name.startsWith("Fill rate"))!;
      const out = await run((tx) => runSavedReport(fx.coord, tx, fill.id, { from: FROM, to: TO }, NOW));
      // Fixture jobs have a position count of 1 and a signed assignment each: all filled.
      expect(out.rows.every((row) => row[1] === "filled")).toBe(true);
    });

    test("save, list, run, soft delete; built-ins and other people's reports cannot be deleted", async () => {
      const { db } = get();
      const saved = await run((tx) => saveReport(fx.coord, tx, "My billing", base({ groupBy: ["vendor"], measures: ["billed_cents"] })));
      expect(saved.ownerUserId).toBe(fx.coord.userId);
      expect(saved.builtIn).toBe(false);
      const other = (await makeUser(db, "coordinator", "eng-coord2@example.test")).actor;
      expect((await run((tx) => listSavedReports(other, tx))).map((r) => r.id)).not.toContain(saved.id);
      expect((await run((tx) => listSavedReports(fx.coord, tx))).map((r) => r.id)).toContain(saved.id);
      const out = await run((tx) => runSavedReport(fx.coord, tx, saved.id, undefined, NOW));
      expect(out.totals.billed_cents).toBe(168000);

      await expect(run((tx) => deleteSavedReport(other, tx, saved.id))).rejects.toBeInstanceOf(NotFoundError);
      const builtIn = (await run((tx) => listSavedReports(fx.coord, tx))).find((r) => r.builtIn)!;
      await expect(run((tx) => deleteSavedReport(fx.coord, tx, builtIn.id))).rejects.toBeInstanceOf(ForbiddenError);
      await run((tx) => deleteSavedReport(fx.coord, tx, saved.id));
      const [row] = await db.select().from(savedReports).where(eq(savedReports.id, saved.id));
      expect(row.deletedAt).not.toBeNull();
      expect((await run((tx) => listSavedReports(fx.coord, tx))).map((r) => r.id)).not.toContain(saved.id);
      await expect(run((tx) => deleteSavedReport(fx.coord, tx, saved.id))).rejects.toBeInstanceOf(NotFoundError);
      const actions = (await db.select().from(auditLog).where(eq(auditLog.entityId, saved.id))).map((a) => a.action).sort();
      expect(actions).toEqual(["saved_report.create", "saved_report.delete"]);
    });

    test("the spec is validated on save and on run", async () => {
      const { db } = get();
      await expect(run((tx) => saveReport(fx.coord, tx, "Bad", { ...base(), groupBy: ["nope" as never] }))).rejects.toBeInstanceOf(ValidationError);
      await expect(run((tx) => saveReport(fx.coord, tx, "Bad", base({ dataset: "messages", groupBy: ["vendor"] })))).rejects.toBeInstanceOf(ValidationError);
      await expect(run((tx) => saveReport(fx.coord, tx, "  ", base()))).rejects.toBeInstanceOf(ValidationError);
      await expect(run((tx) => saveReport(fx.deputy, tx, "Mine", base()))).rejects.toBeInstanceOf(ForbiddenError);
      const ok = await run((tx) => saveReport(fx.coord, tx, "Tamper", base()));
      await db.update(savedReports).set({ spec: { dataset: "invoices", groupBy: ["bogus"] } }).where(eq(savedReports.id, ok.id));
      await expect(run((tx) => runSavedReport(fx.coord, tx, ok.id, undefined, NOW))).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("datasets with real rows (2025)", () => {
    const P = { from: at(2025, 1, 1, 0), to: at(2025, 12, 31, 23) };
    const spec2025 = (o: Partial<ReportSpec>) => base({ ...P, groupBy: ["status"], measures: ["count"], ...o });
    const byStatus = async (o: Partial<ReportSpec>) => {
      const r = await run((tx) => runReport(fx.coord, tx, spec2025(o), NOW));
      return Object.fromEntries(r.rows.map((row) => [row[0], row[1]]));
    };

    test("payment_issues: statuses, and an invoice with two issues is billed once", async () => {
      const { db } = get();
      await db.insert(paymentIssues).values([
        { invoiceId: fx.inv.B.id, openedBy: fx.deputy.userId, status: "open", createdAt: at(2025, 3, 1) },
        { invoiceId: fx.inv.B.id, openedBy: fx.deputy.userId, status: "resolved", createdAt: at(2025, 4, 1) },
        { invoiceId: fx.inv.A.id, openedBy: fx.deputy.userId, status: "paid", createdAt: at(2025, 5, 1) },
      ]);
      expect(await byStatus({ dataset: "payment_issues" })).toEqual({ open: 1, paid: 1, resolved: 1 });
      const r = await run((tx) => runReport(fx.coord, tx, spec2025({ dataset: "payment_issues", groupBy: [], measures: ["count", "billed_cents", "outstanding_cents"] }), NOW));
      expect(r.totals).toEqual({ count: 3, billed_cents: 42000 + 28000, outstanding_cents: 42000 });
      expect(await byStatus({ dataset: "payment_issues", filters: { vendorIds: [fx.otherVendorId] } })).toEqual({});
      expect(await byStatus({ dataset: "payment_issues", filters: { userIds: [fx.deputy.userId], statuses: ["open"] } })).toEqual({ open: 1 });
    });

    test("cancellations and no_shows: status mapping and filters", async () => {
      const { db } = get();
      for (const status of ["canceled", "late_canceled", "no_show"] as const) {
        const { job, positionId } = await fx.mkJob();
        await db.update(jobs).set({ startAt: at(2025, 6, 1, 17), endAt: at(2025, 6, 1, 21) }).where(eq(jobs.id, job.id));
        await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: fx.deputy.userId, status });
      }
      expect(await byStatus({ dataset: "cancellations" })).toEqual({ canceled: 1, late_canceled: 1 });
      expect(await byStatus({ dataset: "cancellations", filters: { statuses: ["late_canceled"] } })).toEqual({ late_canceled: 1 });
      expect(await byStatus({ dataset: "no_shows" })).toEqual({ no_show: 1 });
      expect(await byStatus({ dataset: "assignments", filters: { statuses: ["canceled", "late_canceled", "no_show"] } })).toEqual({ canceled: 1, late_canceled: 1, no_show: 1 });
      await expect(run((tx) => runReport(fx.coord, tx, spec2025({ dataset: "cancellations", filters: { statuses: ["no_show"] } }), NOW))).rejects.toBeInstanceOf(ValidationError);
      const byDeputy = await run((tx) => runReport(fx.coord, tx, spec2025({ dataset: "no_shows", groupBy: ["deputy"], measures: ["count", "hours"] }), NOW));
      expect(byDeputy.rows).toEqual([["eng0", 1, 4]]);
    });

    test("vendor_requests: new requests and change requests split by status", async () => {
      const { db } = get();
      const { job } = await fx.mkJob();
      await db.update(jobs).set({ state: "requested", requestedByUserId: fx.coord.userId, createdAt: at(2025, 2, 1) }).where(eq(jobs.id, job.id));
      const { job: approved } = await fx.mkJob();
      await db.insert(jobChangeRequests).values([
        { jobId: approved.id, requestedBy: fx.coord.userId, patch: {}, status: "pending", createdAt: at(2025, 2, 2) },
        { jobId: approved.id, requestedBy: fx.coord.userId, patch: {}, status: "approved", createdAt: at(2025, 2, 3) },
      ]);
      expect(await byStatus({ dataset: "vendor_requests" })).toEqual({ requested: 1, change_pending: 1, change_approved: 1 });
      expect(await byStatus({ dataset: "vendor_requests", filters: { statuses: ["change_approved"] } })).toEqual({ change_approved: 1 });
      expect(await byStatus({ dataset: "vendor_requests", filters: { statuses: ["requested"] } })).toEqual({ requested: 1 });
      expect(await byStatus({ dataset: "vendor_requests", filters: { vendorIds: [fx.otherVendorId] } })).toEqual({});
    });

    test("ops_plans: status and vendor", async () => {
      const { db } = get();
      await db.insert(opsPlans).values([
        { vendorId: fx.vendorId, eventName: "Fair", year: 2025, status: "due", createdAt: at(2025, 7, 1) },
        { vendorId: fx.vendorId, eventName: "Parade", year: 2025, status: "agreed", createdAt: at(2025, 7, 2) },
        { vendorId: fx.otherVendorId, eventName: "Game", year: 2025, status: "agreed", createdAt: at(2025, 7, 3) },
      ]);
      expect(await byStatus({ dataset: "ops_plans" })).toEqual({ agreed: 2, due: 1 });
      expect(await byStatus({ dataset: "ops_plans", filters: { vendorIds: [fx.otherVendorId] } })).toEqual({ agreed: 1 });
    });

    test("locks_and_overrides: billing overrides, active and resolved holds, and the person or vendor split", async () => {
      const { db } = get();
      await db.insert(billingLockOverrides).values({ userId: fx.deputy.userId, reason: "Out sick", until: at(2025, 9, 30), createdBy: fx.coord.userId, createdAt: at(2025, 9, 1) });
      await db.insert(vendorHolds).values([
        { vendorId: fx.vendorId, placedBy: fx.coord.userId, placedAt: at(2025, 9, 2), reason: "Unpaid" },
        { vendorId: fx.otherVendorId, placedBy: fx.coord.userId, placedAt: at(2025, 9, 3), reason: "Unpaid", resolvedAt: at(2025, 9, 20), resolvedBy: fx.coord.userId, outcome: "handled" },
      ]);
      expect(await byStatus({ dataset: "locks_and_overrides" })).toEqual({ billing_override: 1, vendor_hold_active: 1, vendor_hold_resolved: 1 });
      expect(await byStatus({ dataset: "locks_and_overrides", filters: { userIds: [fx.deputy.userId] } })).toEqual({ billing_override: 1 });
      expect(await byStatus({ dataset: "locks_and_overrides", filters: { vendorIds: [fx.vendorId, fx.otherVendorId] } })).toEqual({ vendor_hold_active: 1, vendor_hold_resolved: 1 });
      expect(await byStatus({ dataset: "locks_and_overrides", filters: { statuses: ["vendor_hold_resolved"] } })).toEqual({ vendor_hold_resolved: 1 });
    });

    test("suspensions: a suspend and a lift come from the audit log", async () => {
      const { db } = get();
      await db.insert(auditLog).values([
        { actorUserId: fx.coord.userId, action: "user.suspend", entityType: "user", entityId: fx.deputy.userId, at: at(2025, 10, 1) },
        { actorUserId: fx.coord.userId, action: "user.suspension_lift", entityType: "user", entityId: fx.deputy.userId, at: at(2025, 10, 10) },
        { actorUserId: fx.coord.userId, action: "user.update", entityType: "user", entityId: fx.deputy.userId, at: at(2025, 10, 11) },
      ]);
      expect(await byStatus({ dataset: "suspensions" })).toEqual({ lifted: 1, suspended: 1 });
      expect(await byStatus({ dataset: "suspensions", filters: { statuses: ["suspended"] } })).toEqual({ suspended: 1 });
      expect(await byStatus({ dataset: "suspensions", filters: { userIds: [fx.deputy2.userId] } })).toEqual({});
      const r = await run((tx) => runReport(fx.coord, tx, spec2025({ dataset: "suspensions", groupBy: ["deputy", "month"] }), NOW));
      expect(r.rows).toEqual([["eng0", "2025-10", 2]]);
    });
  });

  describe("time grouping", () => {
    const wide = (o: Partial<ReportSpec>) => base({ dataset: "audit", from: at(2026, 1, 1, 0), to: at(2027, 12, 31, 23), filters: { statuses: ["tg.test"] }, measures: ["count"], ...o });

    test("weeks run Sunday to Saturday in agency time, across the spring-forward day", async () => {
      const { db } = get();
      const rows = [
        at(2027, 3, 6, 23, 30), // Saturday, last minute of the week of Feb 28
        at(2027, 3, 7, 0, 30), // Sunday
        at(2027, 3, 13, 23, 59), // Saturday before DST starts
        at(2027, 3, 14, 1, 30), // Sunday, CST (before the change)
        at(2027, 3, 14, 3, 30), // Sunday, CDT (after the change)
        at(2026, 12, 31, 23, 30), // Dec 31, 11:30 PM Central is already Jan 1 in UTC
        at(2027, 1, 1, 0, 30),
      ].map((d) => ({ actorUserId: fx.coord.userId, action: "tg.test", entityType: "t", entityId: "1", at: d }));
      await db.insert(auditLog).values(rows);
      const week = await run((tx) => runReport(fx.coord, tx, wide({ groupBy: ["week"] }), NOW));
      expect(week.rows).toEqual([
        ["2026-12-27", 2],
        ["2027-02-28", 1],
        ["2027-03-07", 2],
        ["2027-03-14", 2],
      ]);
      const day = await run((tx) => runReport(fx.coord, tx, wide({ groupBy: ["day"] }), NOW));
      expect(day.rows.map((r) => r[0])).toEqual(["2026-12-31", "2027-01-01", "2027-03-06", "2027-03-07", "2027-03-13", "2027-03-14"]);
      expect(day.rows.find((r) => r[0] === "2027-03-14")?.[1]).toBe(2);
      const year = await run((tx) => runReport(fx.coord, tx, wide({ groupBy: ["year"] }), NOW));
      expect(year.rows).toEqual([["2026", 1], ["2027", 6]]);
    });
  });

  describe("caps and the jobs status filter", () => {
    test("hours by deputy and month sit beside the season's monthly cap", async () => {
      const { db } = get();
      await db.update(seasons).set({ monthCapMinutes: 600 });
      try {
        const list = await run((tx) => listSavedReports(fx.coord, tx));
        const caps = list.find((r) => r.name === "Hours by deputy against caps")!;
        const out = await run((tx) => runSavedReport(fx.coord, tx, caps.id, { from: FROM, to: TO }, NOW));
        expect(out.columns).toEqual(["deputy", "month", "hours", "cap_hours", "over_under_hours"]);
        // eng0 in Jan 2027: B 6h + C 2h + H 1h = 9h against a 10 hour cap.
        expect(out.rows.find((r) => r[0] === "eng0" && r[1] === "2027-01")).toEqual(["eng0", "2027-01", 9, 10, -1]);
        // A 4 hour detail over a lower cap shows as over.
        await db.update(seasons).set({ monthCapMinutes: 480 });
        const over = await run((tx) => runSavedReport(fx.coord, tx, caps.id, { from: FROM, to: TO }, NOW));
        expect(over.rows.find((r) => r[0] === "eng0" && r[1] === "2027-01")).toEqual(["eng0", "2027-01", 9, 8, 1]);
      } finally {
        await db.update(seasons).set({ monthCapMinutes: null });
      }
      const none = await run((tx) => runReport(fx.coord, tx, base({ dataset: "assignments", groupBy: ["deputy", "month"], measures: ["hours", "cap_hours", "over_under_hours"] }), NOW));
      expect(none.rows.find((r) => r[0] === "eng0" && r[1] === "2027-01")).toEqual(["eng0", "2027-01", 9, null, null]);
      await expect(run((tx) => runReport(fx.coord, tx, base({ dataset: "assignments", groupBy: ["deputy"], measures: ["cap_hours"] }), NOW))).rejects.toBeInstanceOf(ValidationError);
    });

    test("the jobs status filter is applied in SQL", async () => {
      const r = await run((tx) => runReport(fx.coord, tx, base({ dataset: "jobs", filters: { statuses: ["expired"] }, groupBy: ["status"] }), NOW));
      expect(r.rows).toEqual([]);
      const filled = await run((tx) => runReport(fx.coord, tx, base({ dataset: "jobs", filters: { statuses: ["filled"] }, groupBy: ["status"] }), NOW));
      expect(filled.rows).toEqual([["filled", 10]]);
    });

    test("audit and message exports label the person column Actor and Sender", async () => {
      const a = (await run((tx) => exportReport(fx.coord, tx, base({ dataset: "audit", groupBy: ["deputy"] }), "csv"))).toString("utf8");
      expect(a.split("\r\n")[0]).toBe("Actor,Count");
      const m = (await run((tx) => exportReport(fx.coord, tx, base({ dataset: "messages", groupBy: ["deputy"] }), "csv"))).toString("utf8");
      expect(m.split("\r\n")[0]).toBe("Sender,Count");
    });
  });

  // Last: it adds more than 50,000 audit rows in a period no other test reads.
  test("more than 50,000 rows is refused with advice to narrow the range", async () => {
    const { db } = get();
    await db.execute(sql`
      insert into audit_log (id, action, entity_type, entity_id, at)
      select 'bulk-' || g, 'bulk.row', 'bulk', g::text, ${agencyInstant(2022, 3, 1, 12, 0).toISOString()}::timestamptz
      from generate_series(1, 50001) g`);
    const spec = base({ dataset: "audit", from: at(2022, 1, 1, 0), to: at(2022, 12, 31, 0), groupBy: ["day"] });
    await expect(run((tx) => runReport(fx.coord, tx, spec))).rejects.toThrow(/narrow/i);
    await run((tx) => runReport(fx.coord, tx, { ...spec, from: at(2022, 3, 2, 0) }));
  });
});
