import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, jobPositions, jobSeries, jobs, notifications, vendorHolds } from "@/db/schema";
import { signUp } from "@/domain/assignments/signup";
import { applyEdit, clockTimes, previewEdit, seriesIds } from "@/domain/jobs/bulk-edit";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { makeUser } from "../users/helpers";
import { setupFixture } from "../assignments/helpers";

describe("quick edit and bulk edit", () => {
  const get = useTestDb();
  useEmailQueue(get);

  test("clock times apply on the detail's own date; an earlier end runs past midnight", () => {
    const job = { startAt: agencyInstant(2035, 3, 1, 17, 0), endAt: agencyInstant(2035, 3, 1, 23, 0) };
    expect(clockTimes(job, "18:30", undefined)).toEqual({ startAt: agencyInstant(2035, 3, 1, 18, 30), endAt: job.endAt });
    expect(clockTimes(job, undefined, "01:00")).toEqual({ startAt: job.startAt, endAt: agencyInstant(2035, 3, 2, 1, 0) });
  });

  test("preview shows before and after for details of different vendors and writes nothing", async () => {
    const f = await setupFixture(get().db, "be1");
    const a = await f.mkJob();
    const b = await f.mkJob({ vendor: f.otherVendorId });
    const rows = await f.run((tx) => previewEdit(f.coord, tx, [a.job.id, b.job.id], { rateCents: 8000, startTime: "16:00", description: "Bring a vest" }));
    expect(rows.map((r) => r.problem)).toEqual([null, null]);
    expect(rows[0].before.rateCents).toBe(7000);
    expect(rows[0].after!.rateCents).toBe(8000);
    expect(rows[0].after!.startAt).toEqual(agencyInstant(2035, 3, 1, 16, 0));
    expect(rows[1].after!.description).toBe("Bring a vest");
    const stored = await get().db.select().from(jobs).where(eq(jobs.id, a.job.id));
    expect(stored[0].rateCents).toBe(7000);
    expect((await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, a.job.id), eq(auditLog.action, "job.update")))).length).toBe(0);
  });

  test("saving is all or nothing and names each refusal", async () => {
    const f = await setupFixture(get().db, "be2");
    const ok = await f.mkJob();
    const started = await f.mkJob();
    await get().db.update(jobs).set({ startAt: new Date(Date.now() - 3_600_000), endAt: new Date(Date.now() + 3_600_000) }).where(eq(jobs.id, started.job.id));
    const locked = await f.mkJob({ vendor: f.otherVendorId });
    await get().db.insert(vendorHolds).values({ vendorId: f.otherVendorId, reason: "Unpaid", placedBy: f.coord.userId, placedAt: new Date() });

    const rows = await f.run((tx) => previewEdit(f.coord, tx, [ok.job.id, started.job.id, locked.job.id], { rateCents: 8000 }));
    expect(rows.find((r) => r.jobId === ok.job.id)!.problem).toBeNull();
    expect(rows.find((r) => r.jobId === started.job.id)!.problem).toMatch(/started/);
    expect(rows.find((r) => r.jobId === locked.job.id)!.problem).toMatch(/payment hold/);

    const err = await f.run((tx) => applyEdit(f.coord, tx, [ok.job.id, started.job.id], { rateCents: 8000 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as Error).message).toMatch(/Nothing was saved/);
    expect((await get().db.select().from(jobs).where(eq(jobs.id, ok.job.id)))[0].rateCents).toBe(7000);
  });

  test("a rate outside the agency range is refused in bulk", async () => {
    const f = await setupFixture(get().db, "be3");
    const admin = (await makeUser(get().db, "admin", "be3-admin@example.test")).actor;
    const a = await f.mkJob();
    const b = await f.mkJob();
    await f.run((tx) => updateSettings(admin, tx, { rateMinCents: 5000, rateMaxCents: 9000 }));
    const rows = await f.run((tx) => previewEdit(f.coord, tx, [a.job.id, b.job.id], { rateCents: 9500 }));
    expect(rows.map((r) => r.problem)).toEqual(["Rate must be between $50 and $90 an hour.", "Rate must be between $50 and $90 an hour."]);
    await f.run((tx) => updateSettings(admin, tx, { rateMinCents: null, rateMaxCents: null }));
  });

  test("saving audits each detail and sends one alert per person summarizing their details", async () => {
    const f = await setupFixture(get().db, "be4");
    const a = await f.mkJob({ count: 2 });
    const b = await f.mkJob({ count: 2 });
    const p = await f.person();
    const q = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1 }));
    await f.run((tx) => signUp(p, tx, b.positionId, { warningVersion: 1 }));
    await f.run((tx) => signUp(q, tx, b.positionId, { warningVersion: 1 }));

    await f.run((tx) => applyEdit(f.coord, tx, [a.job.id, b.job.id], { rateCents: 8000, endTime: "23:30" }));
    const after = await get().db.select().from(jobs).where(eq(jobs.id, a.job.id));
    expect(after[0].rateCents).toBe(8000);
    expect(after[0].endAt).toEqual(agencyInstant(2035, 3, 1, 23, 30));
    for (const id of [a.job.id, b.job.id]) {
      expect((await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, id), eq(auditLog.action, "job.update")))).length).toBe(1);
    }
    const toP = await get().db.select().from(notifications).where(and(eq(notifications.userId, p.userId), eq(notifications.type, "job.changed")));
    expect(toP).toHaveLength(1);
    expect(toP[0].title).toBe("2 of your details changed");
    const toQ = await get().db.select().from(notifications).where(and(eq(notifications.userId, q.userId), eq(notifications.type, "job.changed")));
    expect(toQ).toHaveLength(1);
    expect(toQ[0].title).toMatch(/^Detail changed/);
  });

  test("quick edit on a series changes times on this and later dates; positions sync", async () => {
    const f = await setupFixture(get().db, "be5");
    const a = await f.mkJob();
    const b = await f.mkJob();
    const c = await f.mkJob();
    const [s] = await get().db.insert(jobSeries).values({ name: "s" }).returning();
    for (const j of [a, b, c]) await get().db.update(jobs).set({ seriesId: s.id }).where(eq(jobs.id, j.job.id));
    const ids = await f.run((tx) => seriesIds(tx, b.job.id, "series"));
    expect(ids).toEqual([b.job.id, c.job.id]);
    await f.run((tx) => applyEdit(f.coord, tx, ids, { startTime: "15:00", positions: [{ positionTypeId: f.pos["Deputy Sheriff"], count: 3 }] }));
    const rows = await get().db.select().from(jobs).where(eq(jobs.seriesId, s.id));
    expect(rows.find((r) => r.id === a.job.id)!.startAt).toEqual(a.job.startAt);
    expect(rows.find((r) => r.id === c.job.id)!.startAt).toEqual(agencyInstant(2035, 3, 3, 15, 0));
    const pos = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, c.job.id));
    expect(pos.map((p) => p.count)).toEqual([3]);
  });

  test("personnel cannot edit details", async () => {
    const f = await setupFixture(get().db, "be6");
    const a = await f.mkJob();
    const p = await f.person();
    await expect(f.run((tx) => previewEdit(p, tx, [a.job.id], { rateCents: 8000 }))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await get().db.select().from(assignments)).length).toBeGreaterThanOrEqual(0);
  });
});
