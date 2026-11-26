import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, jobs, notifications } from "@/db/schema";
import { signUp } from "@/domain/assignments/signup";
import { ForbiddenError, RuleViolation } from "@/domain/errors";
import { holdJob, listJobs, releaseJob, updateJob } from "@/domain/jobs/jobs";
import { applyEdit } from "@/domain/jobs/bulk-edit";
import { isReleased } from "@/domain/release/release";
import { loadJobCards } from "@/domain/personnel/views";
import { setupFixture, HOUR } from "../assignments/helpers";
import { byText } from "@/lib/sort";

describe("hold and release", () => {
  const get = useTestDb();
  useEmailQueue(get);

  test("hold hides a released detail from open lists and blocks new sign-ups; existing sign-ups stay", async () => {
    const f = await setupFixture(get().db, "hr1");
    const { job, positionId } = await f.mkJob({ count: 2 });
    const on = await f.person();
    await f.run((tx) => signUp(on, tx, positionId, { warningVersion: 1 }));
    const before = (await get().db.select().from(notifications)).length;

    const [held] = await f.run((tx) => holdJob(f.coord, tx, job.id, "one"));
    expect(held.held).toBe(true);
    // Nobody is alerted about a hold.
    expect(await get().db.select().from(notifications)).toHaveLength(before);
    expect((await get().db.select().from(assignments).where(eq(assignments.jobId, job.id)))[0].status).toBe("signed_up");

    const other = await f.person();
    const window = { from: new Date(job.startAt.getTime() - HOUR), to: new Date(job.startAt.getTime() + HOUR) };
    expect((await f.run((tx) => listJobs(other, tx, window, 1))).map((j) => j.id)).not.toContain(job.id);
    // The person already on it still sees it, marked held.
    const mine = await f.run((tx) => listJobs(on, tx, window, 1));
    const [card] = await f.run((tx) => loadJobCards(on, tx, mine.filter((j) => j.id === job.id)));
    expect(card.held).toBe(true);
    expect(card.availability).toBe("not_released");

    const err = await f.run((tx) => signUp(other, tx, positionId, { warningVersion: 1 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleViolation);

    const audits = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, job.id), eq(auditLog.action, "job.hold")));
    expect(audits).toHaveLength(1);
  });

  test("release clears the hold; Release now opens a detail whose release time has not come", async () => {
    const f = await setupFixture(get().db, "hr2");
    const { job, positionId } = await f.mkJob();
    const later = new Date(Date.now() + 10 * 24 * HOUR);
    await get().db.update(jobs).set({ held: true, releaseAt: later }).where(eq(jobs.id, job.id));

    const [plain] = await f.run((tx) => releaseJob(f.coord, tx, job.id, { scope: "one", now: false }));
    expect(plain.held).toBe(false);
    expect(plain.releaseAt!.getTime()).toBe(later.getTime());

    const t0 = Date.now();
    const [now] = await f.run((tx) => releaseJob(f.coord, tx, job.id, { scope: "one", now: true }));
    expect(now.releaseAt!.getTime()).toBeGreaterThanOrEqual(t0 - 1000);
    expect(now.releaseAt!.getTime()).toBeLessThanOrEqual(Date.now());

    const p = await f.person();
    const a = await f.run((tx) => signUp(p, tx, positionId, { warningVersion: 1 }));
    expect(a.status).toBe("signed_up");

    const actions = (await get().db.select().from(auditLog).where(eq(auditLog.entityId, job.id))).map((r) => r.action);
    expect(actions).toContain("job.release_hold");
    expect(actions).toContain("job.release_now");
  });

  test("series scope holds and releases this and every later detail of the series", async () => {
    const f = await setupFixture(get().db, "hr3");
    const a = await f.mkJob();
    const b = await f.mkJob();
    const c = await f.mkJob();
    const [series] = await get().db.insert((await import("@/db/schema")).jobSeries).values({ name: "s" }).returning();
    for (const j of [a, b, c]) await get().db.update(jobs).set({ seriesId: series.id }).where(eq(jobs.id, j.job.id));

    const held = await f.run((tx) => holdJob(f.coord, tx, b.job.id, "series"));
    expect(held.map((j) => j.id).sort(byText)).toEqual([b.job.id, c.job.id].sort(byText));
    const rows = await get().db.select().from(jobs).where(eq(jobs.seriesId, series.id));
    expect(rows.find((r) => r.id === a.job.id)!.held).toBe(false);

    const released = await f.run((tx) => releaseJob(f.coord, tx, b.job.id, { scope: "series", now: false }));
    expect(released.every((j) => !j.held)).toBe(true);
  });

  test("personnel cannot hold or release", async () => {
    const f = await setupFixture(get().db, "hr4");
    const { job } = await f.mkJob();
    const p = await f.person();
    await expect(f.run((tx) => holdJob(p, tx, job.id, "one"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => releaseJob(p, tx, job.id, { scope: "one", now: true }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a time edit keeps a detail that was already released open (Release now survives)", async () => {
    const f = await setupFixture(get().db, "hr5");
    const a = await f.mkJob();
    const b = await f.mkJob();
    const later = new Date(Date.now() + 10 * 24 * HOUR);
    await get().db.update(jobs).set({ releaseAt: later }).where(eq(jobs.id, a.job.id));
    await get().db.update(jobs).set({ releaseAt: later }).where(eq(jobs.id, b.job.id));
    await f.run((tx) => releaseJob(f.coord, tx, a.job.id, { scope: "one", now: true }));
    await f.run((tx) => releaseJob(f.coord, tx, b.job.id, { scope: "one", now: true }));

    // Edit detail (updateJob) and quick or bulk edit (applyEdit) both move the start time.
    const [edited] = await f.run((tx) => updateJob(f.coord, tx, a.job.id, { startAt: new Date(a.job.startAt.getTime() + HOUR) }, "one"));
    expect(isReleased(edited, new Date())).toBe(true);
    await f.run((tx) => applyEdit(f.coord, tx, [b.job.id], { startTime: "18:00" }));
    const [row] = await get().db.select().from(jobs).where(eq(jobs.id, b.job.id));
    expect(isReleased(row, new Date())).toBe(true);
    const p = await f.person();
    expect((await f.run((tx) => signUp(p, tx, b.positionId, { warningVersion: 1 }))).status).toBe("signed_up");
  });

  test("a time edit on a detail not yet released still follows the month rule", async () => {
    const f = await setupFixture(get().db, "hr6");
    const a = await f.mkJob();
    const future = new Date(Date.now() + 10 * 24 * HOUR);
    await get().db.update(jobs).set({ releaseAt: future }).where(eq(jobs.id, a.job.id));
    const [edited] = await f.run((tx) => updateJob(f.coord, tx, a.job.id, { startAt: new Date(a.job.startAt.getTime() + 40 * 24 * HOUR), endAt: new Date(a.job.endAt.getTime() + 40 * 24 * HOUR) }, "one"));
    expect(edited.releaseAt!.getTime()).not.toBe(future.getTime());
  });
});
