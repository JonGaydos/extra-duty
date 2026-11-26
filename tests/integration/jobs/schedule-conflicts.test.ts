import { describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, jobChangeRequests, jobs, jobSeries, seasons } from "@/db/schema";
import { approveJobChange } from "@/domain/vendor-portal/requests";
import { signUp } from "@/domain/assignments/signup";
import { assignPerson } from "@/domain/assignments/coordinator";
import { RuleViolation } from "@/domain/errors";
import { applyEdit, previewEdit, seriesIds } from "@/domain/jobs/bulk-edit";
import { updateJob, updateJobUnchecked } from "@/domain/jobs/jobs";
import { ScheduleConflictError } from "@/domain/jobs/schedule-conflicts";
import { ForbiddenError } from "@/domain/errors";
import { makeUser } from "../users/helpers";
import { setupFixture, HOUR } from "../assignments/helpers";

/**
 * Owner decision: a time edit that would double-book a deputy already on the detail, or break their hour caps,
 * is refused until each conflict is resolved or a coordinator overrides it with a reason (audited).
 */
describe("schedule conflicts on time edits", () => {
  const get = useTestDb();
  useEmailQueue(get);

  /** Two details on the same day, 17:00-23:00 and a later one moved to overlap; the deputy holds a spot on both. */
  async function twoDetails(prefix: string) {
    const f = await setupFixture(get().db, prefix);
    const a = await f.mkJob({ hours: [8, 12] });
    const b = await f.mkJob({ hours: [8, 12] });
    // Put b on a's date, after it.
    await get().db.update(jobs).set({ startAt: new Date(a.job.startAt.getTime() + 6 * HOUR), endAt: new Date(a.job.startAt.getTime() + 9 * HOUR) }).where(eq(jobs.id, b.job.id));
    const p = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1 }));
    await f.run((tx) => signUp(p, tx, b.positionId, { warningVersion: 1 }));
    const [jobA] = await get().db.select().from(jobs).where(eq(jobs.id, a.job.id));
    const [jobB] = await get().db.select().from(jobs).where(eq(jobs.id, b.job.id));
    return { f, p, a: jobA, b: jobB };
  }

  test("an edit that overlaps an assigned deputy's other detail is refused with the engine's message", async () => {
    const { f, p, a, b } = await twoDetails("sc1");
    // Moving a to end an hour into b overlaps b.
    const err = await f.run((tx) => updateJob(f.coord, tx, a.id, { endAt: new Date(b.startAt.getTime() + HOUR) }, "one")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScheduleConflictError);
    const c = (err as ScheduleConflictError).conflicts;
    expect(c).toHaveLength(1);
    expect(c[0]).toMatchObject({ userId: p.userId, jobId: a.id, check: "overlap", message: `Overlaps job #${b.number}` });
    expect((await get().db.select().from(jobs).where(eq(jobs.id, a.id)))[0].endAt).toEqual(a.endAt);
  });

  test("the bulk preview lists conflicts, saving refuses them, and an override with a reason saves and is audited", async () => {
    const { f, p, a, b } = await twoDetails("sc2");
    const rows = await f.run((tx) => previewEdit(f.coord, tx, [a.id], { endTime: "16:00" }));
    expect(rows[0].problem).toBeNull();
    expect(rows[0].conflicts.map((c) => c.message)).toEqual([`Overlaps job #${b.number}`]);
    await expect(f.run((tx) => applyEdit(f.coord, tx, [a.id], { endTime: "16:00" }))).rejects.toBeInstanceOf(ScheduleConflictError);

    await f.run((tx) => applyEdit(f.coord, tx, [a.id], { endTime: "16:00", conflictOverride: { reason: "Deputy agreed to swap with a partner", fingerprints: { [a.id]: rows[0].conflictFingerprint! } } }));
    const [saved] = await get().db.select().from(jobs).where(eq(jobs.id, a.id));
    expect(saved.endAt.getTime()).toBeGreaterThan(b.startAt.getTime());
    const [audit] = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, a.id), eq(auditLog.action, "job.schedule_conflict_override")));
    expect(audit.reason).toBe("Deputy agreed to swap with a partner");
    expect(JSON.stringify(audit.after)).toContain(p.userId);
    expect(JSON.stringify(audit.after)).toContain(`Overlaps job #${b.number}`);
  });

  test("removing the deputy resolves the conflict", async () => {
    const { f, p, a, b } = await twoDetails("sc3");
    await get().db.update(assignments).set({ status: "removed", removalReason: "Swapped" }).where(and(eq(assignments.jobId, a.id), eq(assignments.userId, p.userId)));
    await f.run((tx) => applyEdit(f.coord, tx, [a.id], { endTime: "16:00" }));
    expect((await get().db.select().from(jobs).where(eq(jobs.id, a.id)))[0].endAt.getTime()).toBeGreaterThan(b.startAt.getTime());
  });

  test("deputies and vendors can never override", async () => {
    const { f, a, b } = await twoDetails("sc4");
    const deputy = await f.person();
    await expect(f.run((tx) => updateJob(deputy, tx, a.id, { endAt: new Date(b.startAt.getTime() + HOUR), conflictOverride: { reason: "x", fingerprint: "any" } }, "one"))).rejects.toBeInstanceOf(ForbiddenError);
    const vendor = { ...(await makeUser(get().db, "vendor", "sc4-vendor@example.test")).actor, vendorId: f.vendorId };
    // The vendor portal's own path reaches the same edit without the policy check: the override is still refused.
    const shown = (await f.run((tx) => updateJob(f.coord, tx, a.id, { endAt: new Date(b.startAt.getTime() + HOUR) }, "one")).catch((e: ScheduleConflictError) => e)) as ScheduleConflictError;
    const fingerprint = shown.fingerprints[a.id];
    await expect(f.run((tx) => updateJobUnchecked(vendor, tx, a.id, { endAt: new Date(b.startAt.getTime() + HOUR), conflictOverride: { reason: "x", fingerprint } }, "one"))).rejects.toBeInstanceOf(ScheduleConflictError);
  });

  test("a series edit lists conflicts per date", async () => {
    const f = await setupFixture(get().db, "sc5");
    const s1 = await f.mkJob({ hours: [8, 12] });
    const s2 = await f.mkJob({ hours: [8, 12] });
    const [series] = await get().db.insert(jobSeries).values({ name: "s" }).returning();
    for (const j of [s1, s2]) await get().db.update(jobs).set({ seriesId: series.id }).where(eq(jobs.id, j.job.id));
    const p = await f.person();
    // The deputy is on both dates of the series and on an afternoon detail each day.
    const others = [];
    for (const j of [s1, s2]) {
      await f.run((tx) => signUp(p, tx, j.positionId, { warningVersion: 1 }));
      const o = await f.mkJob({ hours: [8, 12] });
      await get().db.update(jobs).set({ startAt: new Date(j.job.startAt.getTime() + 5 * HOUR), endAt: new Date(j.job.startAt.getTime() + 8 * HOUR) }).where(eq(jobs.id, o.job.id));
      await f.run((tx) => signUp(p, tx, o.positionId, { warningVersion: 1 }));
      others.push(o.job);
    }
    const rows = await f.run((tx) => previewEdit(f.coord, tx, [s1.job.id, s2.job.id], { endTime: "14:00" }));
    expect(rows.map((r) => r.conflicts.map((c) => c.message))).toEqual([[`Overlaps job #${others[0].number}`], [`Overlaps job #${others[1].number}`]]);
  });

  test("placing a deputy on an overlapping detail needs an override; the audit names the conflict", async () => {
    const { f, p, a } = await twoDetails("sc6");
    const c = await f.mkJob({ hours: [8, 12] });
    await get().db.update(jobs).set({ startAt: a.startAt, endAt: a.endAt }).where(eq(jobs.id, c.job.id));
    const err = await f.run((tx) => assignPerson(f.coord, tx, c.positionId, p.userId, { notify: false })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleViolation);
    expect((err as RuleViolation).checks.map((x) => x.message)).toContain(`Overlaps job #${a.number}`);
    const row = await f.run((tx) => assignPerson(f.coord, tx, c.positionId, p.userId, { notify: false, overrideReason: "Covering the gate for ten minutes" }));
    const [audit] = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "assignment.assign")));
    expect(audit.reason).toBe("Covering the gate for ten minutes");
    expect(JSON.stringify(audit.after)).toContain(`Overlaps job #${a.number}`);
  });

  test("an override is bound to the conflicts that were shown; a different set is refused", async () => {
    const { f, a, b } = await twoDetails("sc7");
    const shown = (await f.run((tx) => updateJob(f.coord, tx, a.id, { endAt: new Date(b.startAt.getTime() + HOUR) }, "one")).catch((e: ScheduleConflictError) => e)) as ScheduleConflictError;
    const fingerprint = shown.fingerprints[a.id];
    expect(fingerprint).toMatch(/^[0-9a-f]{16}$/);
    // A second deputy on a who also works a later detail c: a longer edit now overlaps c for them as well.
    const c = await f.mkJob({ hours: [8, 12] });
    await get().db.update(jobs).set({ startAt: new Date(b.endAt.getTime() + HOUR), endAt: new Date(b.endAt.getTime() + 2 * HOUR) }).where(eq(jobs.id, c.job.id));
    const q = await f.person();
    const [aPos] = await get().db.select().from(assignments).where(eq(assignments.jobId, a.id));
    await get().db.insert(assignments).values({ jobId: a.id, jobPositionId: aPos.jobPositionId, userId: q.userId, status: "signed_up" });
    await get().db.insert(assignments).values({ jobId: c.job.id, jobPositionId: c.positionId, userId: q.userId, status: "signed_up" });
    const longer = { endAt: new Date(b.endAt.getTime() + 90 * 60_000), conflictOverride: { reason: "Agreed", fingerprint } };
    const listed = (await f.run((tx) => updateJob(f.coord, tx, a.id, { endAt: longer.endAt }, "one")).catch((e: ScheduleConflictError) => e)) as ScheduleConflictError;
    expect(listed.conflicts.map((x) => x.userId)).toContain(q.userId);
    await expect(f.run((tx) => updateJob(f.coord, tx, a.id, longer, "one"))).rejects.toBeInstanceOf(ScheduleConflictError);
    // The exact edit that was shown saves with its fingerprint (q has no conflict at that end time).
    await f.run((tx) => updateJob(f.coord, tx, a.id, { endAt: new Date(b.startAt.getTime() + HOUR), conflictOverride: { reason: "Agreed", fingerprint } }, "one"));
  });

  test("approving a vendor's time change lists conflicts and saves only with a bound override", async () => {
    const { f, a, b } = await twoDetails("sc8");
    const vendorUser = (await makeUser(get().db, "vendor", "sc8-vendor@example.test")).row;
    const [req] = await get().db
      .insert(jobChangeRequests)
      .values({ jobId: a.id, requestedBy: vendorUser.id, patch: { startAt: a.startAt.toISOString(), endAt: new Date(b.startAt.getTime() + HOUR).toISOString() } })
      .returning();
    const err = (await f.run((tx) => approveJobChange(f.coord, tx, req.id)).catch((e: unknown) => e)) as ScheduleConflictError;
    expect(err).toBeInstanceOf(ScheduleConflictError);
    await f.run((tx) => approveJobChange(f.coord, tx, req.id, new Date(), { conflictOverride: { reason: "Vendor confirmed overlap is fine", fingerprint: err.fingerprints[a.id] } }));
    const [audit] = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, a.id), eq(auditLog.action, "job.schedule_conflict_override")));
    expect(audit.reason).toBe("Vendor confirmed overlap is fine");
  });
});

describe("planned times follow a time edit", () => {
  const get = useTestDb();
  useEmailQueue(get);

  test("a fixed-time detail moves every active assignment's planned times, on every edit path", async () => {
    const f = await setupFixture(get().db, "pt1");
    const a = await f.mkJob({ count: 3 });
    const b = await f.mkJob({ count: 2 });
    const p = await f.person();
    const q = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1 }));
    await f.run((tx) => signUp(q, tx, b.positionId, { warningVersion: 1 }));
    const [edited] = await f.run((tx) => updateJob(f.coord, tx, a.job.id, { startAt: new Date(a.job.startAt.getTime() + HOUR), endAt: new Date(a.job.endAt.getTime() + HOUR) }, "one"));
    const [pa] = await get().db.select().from(assignments).where(eq(assignments.jobId, a.job.id));
    expect([pa.plannedStartAt, pa.plannedEndAt]).toEqual([edited.startAt, edited.endAt]);

    await f.run((tx) => applyEdit(f.coord, tx, [b.job.id], { startTime: "16:00", endTime: "22:00" }));
    const [jb] = await get().db.select().from(jobs).where(eq(jobs.id, b.job.id));
    const [pb] = await get().db.select().from(assignments).where(eq(assignments.jobId, b.job.id));
    expect([pb.plannedStartAt, pb.plannedEndAt]).toEqual([jb.startAt, jb.endAt]);
  });

  test("a flexible detail keeps each person's planned shift; one outside the new window is a conflict", async () => {
    const f = await setupFixture(get().db, "pt2");
    const a = await f.mkJob({ hours: [17, 21] });
    const at = (h: number) => new Date(a.job.startAt.getTime() + (h - 17) * HOUR);
    await get().db.update(jobs).set({ flexEarliestStartAt: at(15), flexLatestEndAt: at(23) }).where(eq(jobs.id, a.job.id));
    const p = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1, plannedStartAt: at(15), plannedEndAt: at(19) }));
    // Inside the new window: kept as is.
    await f.run((tx) => updateJob(f.coord, tx, a.job.id, { startAt: at(18), endAt: at(22), flex: { earliestStartAt: at(15), latestEndAt: at(23), allowShorter: false } }, "one"));
    let [row] = await get().db.select().from(assignments).where(eq(assignments.jobId, a.job.id));
    expect([row.plannedStartAt, row.plannedEndAt]).toEqual([at(15), at(19)]);
    // The window now starts at 4 PM: the 3 PM shift falls outside and is listed.
    const err = await f.run((tx) => updateJob(f.coord, tx, a.job.id, { flex: { earliestStartAt: at(16), latestEndAt: at(23), allowShorter: false } }, "one")).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ScheduleConflictError);
    expect((err as ScheduleConflictError).conflicts[0].check).toBe("schedule.window");
    [row] = await get().db.select().from(assignments).where(eq(assignments.jobId, a.job.id));
    expect(row.plannedStartAt).toEqual(at(15));
  });

  test("turning a flexible detail into a fixed one moves each planned shift to the detail's times", async () => {
    const f = await setupFixture(get().db, "pt3");
    const a = await f.mkJob({ hours: [17, 21] });
    const at = (h: number) => new Date(a.job.startAt.getTime() + (h - 17) * HOUR);
    await get().db.update(jobs).set({ flexEarliestStartAt: at(15), flexLatestEndAt: at(23) }).where(eq(jobs.id, a.job.id));
    const p = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1, plannedStartAt: at(15), plannedEndAt: at(19) }));
    // Same start and end: only the flexible window goes.
    await f.run((tx) => updateJob(f.coord, tx, a.job.id, { flex: null }, "one"));
    const [row] = await get().db.select().from(assignments).where(eq(assignments.jobId, a.job.id));
    expect([row.plannedStartAt, row.plannedEndAt]).toEqual([at(17), at(21)]);
  });
});

describe("overrides across several details in one edit", () => {
  const get = useTestDb();
  useEmailQueue(get);

  /** Two details in the same week, 17:00 to 23:00 each (12 hours), with a 12h20m week cap. */
  async function sameWeek(prefix: string) {
    const f = await setupFixture(get().db, prefix);
    const a = await f.mkJob();
    const b = await f.mkJob();
    const p = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1 }));
    await f.run((tx) => signUp(p, tx, b.positionId, { warningVersion: 1 }));
    await get().db.update(seasons).set({ weekCapMinutes: 740 });
    return { f, a: a.job, b: b.job };
  }
  const restore = () => get().db.update(seasons).set({ weekCapMinutes: null });

  test("bulk: the preview's conflicts match the save's, so the override saves", async () => {
    const { f, a, b } = await sameWeek("ov1");
    try {
      const rows = await f.run((tx) => previewEdit(f.coord, tx, [a.id, b.id], { endTime: "23:30" }));
      // The second detail is checked against the first one's new end, as the save does.
      expect(rows.map((r) => r.conflicts.map((c) => c.message))).toEqual([["Week cap: 12.5 of 12.33 hours with this detail"], ["Week cap: 13 of 12.33 hours with this detail"]]);
      const fingerprints = Object.fromEntries(rows.map((r) => [r.jobId, r.conflictFingerprint!]));
      await f.run((tx) => applyEdit(f.coord, tx, [a.id, b.id], { endTime: "23:30", conflictOverride: { reason: "Holiday weekend", fingerprints } }));
      const ends = await get().db.select({ id: jobs.id, endAt: jobs.endAt }).from(jobs).where(eq(jobs.seriesId, jobs.seriesId));
      expect(ends.filter((j) => j.id === a.id || j.id === b.id).every((j) => j.endAt.getTime() === (j.id === a.id ? a.endAt : b.endAt).getTime() + 30 * 60_000)).toBe(true);
    } finally {
      await restore();
    }
  });

  test("series quick edit: the refused save's fingerprints are the ones the override needs", async () => {
    const { f, a, b } = await sameWeek("ov2");
    try {
      const [s] = await get().db.insert(jobSeries).values({ name: "s" }).returning();
      for (const j of [a, b]) await get().db.update(jobs).set({ seriesId: s.id }).where(eq(jobs.id, j.id));
      const ids = await f.run((tx) => seriesIds(tx, a.id, "series"));
      const refused = (await f.run((tx) => applyEdit(f.coord, tx, ids, { endTime: "23:30" })).catch((e: ScheduleConflictError) => e)) as ScheduleConflictError;
      expect(refused).toBeInstanceOf(ScheduleConflictError);
      expect(refused.conflicts.map((c) => c.message)).toEqual(["Week cap: 12.5 of 12.33 hours with this detail", "Week cap: 13 of 12.33 hours with this detail"]);
      await f.run((tx) => applyEdit(f.coord, tx, ids, { endTime: "23:30", conflictOverride: { reason: "Holiday weekend", fingerprints: refused.fingerprints } }));
      const audits = await get().db.select().from(auditLog).where(eq(auditLog.action, "job.schedule_conflict_override"));
      expect(audits.filter((x) => x.entityId === a.id || x.entityId === b.id)).toHaveLength(2);
    } finally {
      await restore();
    }
  });
});
