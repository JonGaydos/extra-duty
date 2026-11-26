import { beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, files, notifications, vendorLocations, jobAttachments, jobPositions, jobSafetyAddresses, jobSeries, jobs, jobTypes, positionTypes, ranks, users, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { copyJob, createJobsOnDates, createRecurringJobs } from "@/domain/jobs/copy";
import { createJob, getJob, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { updateSettings } from "@/domain/settings/settings";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";
import { resetGeocoder } from "@/domain/vendors/geocode";
import { byText } from "@/lib/sort";

// Fake fetches are async to match fetch; they answer at once.

describe("bulk dates, copy and series", () => {
  const get = useTestDb();
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);
  let coord: Actor;
  let deputy: Actor;
  let vendorId: string;
  let typeId: string;
  let pos: Record<string, string>;
  let rank: Record<string, string>;
  /** A deputy who can fill every position used here (Deputy Sheriff rank). */
  const deputyUser = async (email: string, extra: Partial<typeof users.$inferInsert> = {}) => (await makeUser(get().db, "personnel", email, { rankId: rank["Deputy Sheriff"], ...extra })).actor;
  /** Copy clock: well before every 2035 date used here. */
  const NOW = agencyInstant(2035, 1, 2, 9, 0);
  const dates = ["2035-06-01", "2035-06-08", "2035-06-15", "2035-06-22", "2035-06-29", "2035-07-06"];

  const base = (over: Partial<JobInput> = {}): JobInput => ({
    vendorId,
    locationId: null,
    typeId,
    title: "Home games",
    description: null,
    notes: null,
    startAt: agencyInstant(2035, 5, 1, 17, 0),
    endAt: agencyInstant(2035, 5, 1, 23, 0),
    rateCents: null,
    positions: [
      { positionTypeId: pos["Deputy Sheriff"], count: 2 },
      { positionTypeId: pos["CSO"], count: 1 },
    ],
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: null,
    contactPhone: null,
    held: false,
    ...over,
  });
  const positionsOf = async (id: string) =>
    (await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, id))).map((p) => `${p.positionTypeId}:${p.count}`).sort(byText);

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coord = (await makeUser(db, "coordinator", "ccoord@example.test")).actor;
    deputy = (await makeUser(db, "personnel", "cdeputy@example.test")).actor;
    const [v] = await db.insert(vendors).values({ name: "Alpha", defaultRateCents: 7000 }).returning();
    vendorId = v.id;
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    pos = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
    rank = Object.fromEntries((await db.select().from(ranks)).map((r) => [r.name, r.id]));
    await run((tx) => updateSettings(coord, tx, { agencyDefaultRateCents: 6500, defaultPositionTypeId: pos["Deputy Sheriff"] }));
    resetGeocoder({ intervalMs: 0 });
  });

  test("six dates create six jobs in one series with identical positions", async () => {
    const out = await run((tx) => createJobsOnDates(coord, tx, base(), dates));
    expect(out).toHaveLength(6);
    expect(new Set(out.map((j) => j.seriesId)).size).toBe(1);
    expect(out[0].seriesId).toBeTruthy();
    expect(out.map((j) => agencyDateParts(j.startAt).day)).toEqual([1, 8, 15, 22, 29, 6]);
    const first = await positionsOf(out[0].id);
    for (const j of out) expect(await positionsOf(j.id)).toEqual(first);
    const log = await get().db.select().from(auditLog);
    expect(log.filter((a) => a.action === "job.create" && out.some((j) => j.id === a.entityId))).toHaveLength(6);
    expect(log.filter((a) => a.action === "series.created" && a.entityId === out[0].seriesId)).toHaveLength(1);
  });

  test("a failing date rolls everything back", async () => {
    const before = (await get().db.select().from(jobs)).length;
    const seriesBefore = (await get().db.select().from(jobSeries)).length;
    await expect(run((tx) => createJobsOnDates(coord, tx, base(), dates, { "2035-07-06": { startTime: "25:00" } }))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => createJobsOnDates(coord, tx, base({ positions: [{ positionTypeId: pos["CSO"], count: 0 }] }), dates))).rejects.toBeInstanceOf(ValidationError);
    expect(await get().db.select().from(jobs)).toHaveLength(before);
    expect(await get().db.select().from(jobSeries)).toHaveLength(seriesBefore);
    await expect(run((tx) => createJobsOnDates(coord, tx, base(), []))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => createJobsOnDates(deputy, tx, base(), dates))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a failure on a later date undoes earlier jobs, the series, positions, attachments and audit rows", async () => {
    const { db } = get();
    const src = await run((tx) => createJob(coord, tx, base()));
    await db.insert(jobAttachments).values({ jobId: src.id, label: "Map", url: "https://example.test/rb" });
    const counts = async () => ({
      jobs: (await db.select().from(jobs)).length,
      series: (await db.select().from(jobSeries)).length,
      positions: (await db.select().from(jobPositions)).length,
      attachments: (await db.select().from(jobAttachments)).length,
      audit: (await db.select().from(auditLog)).length,
    });
    const before = await counts();
    // 2035-03-11 is the spring-forward day: 02:30 becomes 03:30, so a 03:00 end is before the start.
    const err = await run((tx) =>
      createJobsOnDates(coord, tx, base(), ["2035-03-09", "2035-03-10", "2035-03-11"], { "2035-03-11": { startTime: "02:30", endTime: "03:00" } }, { attachmentsFromJobId: src.id }),
    ).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toContain("2035-03-11");
    expect(await counts()).toEqual(before);
  });

  test("safety addresses are looked up once for the whole batch", async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(JSON.stringify([{ lat: "30.5", lon: "-86.1" }]), { status: 200 })));
    vi.stubGlobal("fetch", fetchMock);
    try {
      const out = await run((tx) =>
        createJobsOnDates(coord, tx, base({ safety: { notes: "Gate B", addresses: [{ address: "1 Main St", description: "Entrance" }] } }), dates),
      );
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const rows = await get().db.select().from(jobSafetyAddresses).where(eq(jobSafetyAddresses.address, "1 Main St"));
      expect(rows.filter((r) => out.some((j) => j.id === r.jobId))).toHaveLength(6);
      expect(rows[0].lat).toBe(30.5);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  test("overnight times and per-date overrides apply in agency time (spring-forward night is 9 hours)", async () => {
    const out = await run((tx) =>
      createJobsOnDates(coord, tx, base({ startAt: agencyInstant(2035, 5, 1, 20, 0), endAt: agencyInstant(2035, 5, 2, 6, 0) }), ["2035-03-10", "2035-03-20"], {
        "2035-03-20": { startTime: "19:00", endTime: "22:00" },
      }),
    );
    expect(out[0].endAt.getTime() - out[0].startAt.getTime()).toBe(9 * 3_600_000);
    expect(out[1].endAt.getTime() - out[1].startAt.getTime()).toBe(3 * 3_600_000);
  });

  test("a copy carries the detail itself: vendor, location, text, positions and differentials, rate, flex, safety, contact and attachments", async () => {
    const { db } = get();
    const [loc] = await db.insert(vendorLocations).values({ vendorId, name: "North lot", address: "9 Bay Rd", lat: 30.4, lng: -86.2 }).returning();
    const flex = { earliestStartAt: agencyInstant(2035, 5, 1, 16, 0), latestEndAt: agencyInstant(2035, 5, 2, 0, 0), allowShorter: true };
    const src = await run((tx) =>
      createJob(
        coord,
        tx,
        base({
          locationId: loc.id,
          title: "Copy every field",
          description: "Parking and crowd control",
          notes: "Bring a vest",
          rateCents: 8000,
          flex,
          contactName: "Gate office",
          contactPhone: "850-555-0101",
          safety: { notes: "Watch gate", addresses: [{ address: "2 Oak Ave", description: "Lot", lat: 1, lng: 2 }] },
        }),
      ),
    );
    // The CSO position's differential was snapshotted when the source was made; a later change to the type must not leak in.
    await db.update(jobPositions).set({ rateDifferentialCents: 250 }).where(and(eq(jobPositions.jobId, src.id), eq(jobPositions.positionTypeId, pos["CSO"])));
    const [file] = await db.insert(files).values({ storageKey: "k-copy-1", filename: "c.pdf", contentType: "application/pdf", size: 1, kind: "contract" }).returning();
    await db.insert(jobAttachments).values([
      { jobId: src.id, label: "Contract", fileId: file.id, isContract: true },
      { jobId: src.id, label: "Map", url: "https://example.test/map" },
    ]);
    const filesBefore = (await db.select().from(files)).length;
    const { jobs: out } = await run((tx) => copyJob(coord, tx, src.id, { kind: "dates", dates: ["2035-08-01", "2035-08-02"] }, { now: NOW }));
    expect(out).toHaveLength(2);
    expect(new Set(out.map((j) => j.seriesId)).size).toBe(1);
    const source = await run((tx) => getJob(coord, tx, src.id));
    const diffs = async (id: string) => (await db.select().from(jobPositions).where(eq(jobPositions.jobId, id))).map((p) => `${p.positionTypeId}:${p.count}:${p.rateDifferentialCents}`).sort(byText);
    for (const j of out) {
      const d = await run((tx) => getJob(coord, tx, j.id));
      expect(d).toMatchObject({
        vendorId,
        locationId: loc.id,
        title: "Copy every field",
        description: "Parking and crowd control",
        notes: "Bring a vest",
        rateCents: 8000,
        contactName: "Gate office",
        contactPhone: "850-555-0101",
        flexAllowShorter: true,
      });
      expect(await diffs(j.id)).toEqual(await diffs(src.id));
      expect(d.safety?.notes).toBe("Watch gate");
      expect(d.safety?.addresses.map((a) => [a.address, a.description, a.lat, a.lng])).toEqual(source.safety!.addresses.map((a) => [a.address, a.description, a.lat, a.lng]));
      expect(d.flexEarliestStartAt!.getTime()).toBe(j.startAt.getTime() - 3_600_000);
      expect(d.flexLatestEndAt!.getTime()).toBe(j.endAt.getTime() + 3_600_000);
      expect(d.attachments.map((a) => [a.label, a.isContract, a.fileId, a.url]).sort((a, b) => byText(String(a), String(b)))).toEqual([
        ["Contract", true, file.id, null],
        ["Map", false, null, "https://example.test/map"],
      ]);
    }
    // The copies point at the same stored file: no file data is duplicated.
    expect(await db.select().from(files)).toHaveLength(filesBefore);
  });

  test("Repeat keeps the source's differentials and attachments, carries no people, and refuses past dates", async () => {
    const { db } = get();
    const src = await run((tx) => createJob(coord, tx, base({ title: "Repeat src", startAt: agencyInstant(2035, 10, 7, 17, 0), endAt: agencyInstant(2035, 10, 7, 23, 0) })));
    await db.update(jobPositions).set({ rateDifferentialCents: 375 }).where(and(eq(jobPositions.jobId, src.id), eq(jobPositions.positionTypeId, pos["CSO"])));
    await db.insert(jobAttachments).values({ jobId: src.id, label: "Map", url: "https://example.test/repeat-map" });
    const p = await deputyUser("rep-a@example.test");
    const [spot] = await db.select().from(jobPositions).where(and(eq(jobPositions.jobId, src.id), eq(jobPositions.positionTypeId, pos["Deputy Sheriff"])));
    await db.insert(assignments).values({ jobId: src.id, jobPositionId: spot.id, userId: p.userId, status: "signed_up" });
    const diffs = async (id: string) => (await db.select().from(jobPositions).where(eq(jobPositions.jobId, id))).map((x) => `${x.positionTypeId}:${x.count}:${x.rateDifferentialCents}`).sort(byText);

    const out = await run((tx) => createRecurringJobs(coord, tx, src.id, { kind: "weekly", every: 1, weekdays: [0], end: { count: 3 } }, NOW));
    expect(out).toHaveLength(2);
    for (const j of out) {
      expect(await diffs(j.id)).toEqual(await diffs(src.id));
      expect((await db.select().from(jobAttachments).where(eq(jobAttachments.jobId, j.id))).map((a) => a.url)).toEqual(["https://example.test/repeat-map"]);
      expect(await db.select().from(assignments).where(eq(assignments.jobId, j.id))).toEqual([]);
    }

    // Repeating a detail from the past: the later dates before today are refused, naming the first one.
    const old = await run((tx) => createJob(coord, tx, base({ title: "Old repeat src", startAt: agencyInstant(2035, 5, 6, 17, 0), endAt: agencyInstant(2035, 5, 6, 23, 0) })));
    const before = (await db.select().from(jobs)).length;
    const err = await run((tx) => createRecurringJobs(coord, tx, old.id, { kind: "weekly", every: 1, weekdays: [0], end: { count: 3 } }, agencyInstant(2035, 5, 15, 9, 0))).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("2035-05-13: A copy cannot be made on a past date. Choose today or a later date.");
    expect(await db.select().from(jobs)).toHaveLength(before);
  });

  test("a copy never carries people: signed-up, backup and billed people stay on the source, and nobody gets an alert", async () => {
    const { db } = get();
    const [signed, backup, billed] = [await deputyUser("np-a@example.test"), await deputyUser("np-b@example.test"), await deputyUser("np-c@example.test")];
    const src = await run((tx) => createJob(coord, tx, base({ title: "No people src", startAt: agencyInstant(2035, 8, 25, 17, 0), endAt: agencyInstant(2035, 8, 25, 23, 0), positions: [{ positionTypeId: pos["Deputy Sheriff"], count: 2 }] })));
    const [spot] = await db.select().from(jobPositions).where(eq(jobPositions.jobId, src.id));
    await db.insert(assignments).values([
      { jobId: src.id, jobPositionId: spot.id, userId: signed.userId, status: "signed_up" },
      { jobId: src.id, jobPositionId: spot.id, userId: billed.userId, status: "billed" },
      { jobId: src.id, jobPositionId: spot.id, userId: backup.userId, status: "backup", backupPosition: 1 },
    ]);
    const people = [signed.userId, backup.userId, billed.userId];
    const alertsBefore = (await db.select().from(notifications).where(inArray(notifications.userId, people))).length;
    // Even a caller still sending the old "copy the people" flag gets an empty roster.
    const legacy = { now: NOW, copyAssignments: true };
    const single = await run((tx) => copyJob(coord, tx, src.id, { kind: "dates", dates: ["2035-09-01", "2035-09-02"] }, legacy));
    const repeated = await run((tx) => createRecurringJobs(coord, tx, src.id, { kind: "weekly", every: 1, weekdays: [6], end: { count: 2 } }));
    for (const j of [...single.jobs, ...repeated]) expect(await db.select().from(assignments).where(eq(assignments.jobId, j.id))).toEqual([]);
    expect(await db.select().from(assignments).where(eq(assignments.jobId, src.id))).toHaveLength(3);
    expect(await db.select().from(notifications).where(inArray(notifications.userId, people))).toHaveLength(alertsBefore);
    expect(await db.select().from(auditLog).where(eq(auditLog.action, "assignment.copy"))).toEqual([]);
  });


  test("a copy onto a past agency date is refused, naming the date; today is allowed", async () => {
    const src = await run((tx) => createJob(coord, tx, base({ title: "Past copy" })));
    // 23:30 on Sep 9 in agency time is already Sep 10 in UTC: the agency day decides, so Sep 9 is still today.
    const now = agencyInstant(2035, 9, 9, 23, 30);
    expect(now.toISOString().slice(0, 10)).toBe("2035-09-10");
    const before = (await get().db.select().from(jobs)).length;
    const err = await run((tx) => copyJob(coord, tx, src.id, { kind: "dates", dates: ["2035-09-12", "2035-09-08"] }, { now })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("2035-09-08: A copy cannot be made on a past date. Choose today or a later date.");
    expect(await get().db.select().from(jobs)).toHaveLength(before);
    const ok = await run((tx) => copyJob(coord, tx, src.id, { kind: "dates", dates: ["2035-09-09"] }, { now }));
    expect(ok.jobs).toHaveLength(1);
  });

  test("a pattern copy leaves out the source's own date", async () => {
    const src = await run((tx) => createJob(coord, tx, base({ startAt: agencyInstant(2035, 11, 4, 8, 0), endAt: agencyInstant(2035, 11, 4, 12, 0) })));
    const res = await run((tx) =>
      copyJob(coord, tx, src.id, { kind: "pattern", recurrence: { kind: "weekly", every: 1, weekdays: [0], end: { count: 3 } } }),
    );
    expect(res.jobs.map((j) => agencyDateParts(j.startAt).day)).toEqual([11, 18]);
  });

  test("a series made here updates through scope series", async () => {
    const out = await run((tx) => createJobsOnDates(coord, tx, base({ title: "Series edit" }), dates));
    const changed = await run((tx) => updateJob(coord, tx, out[2].id, { title: "Renamed" }, "series"));
    expect(changed.map((j) => j.id).sort(byText)).toEqual(out.slice(2).map((j) => j.id).sort(byText));
    const rows = await get().db.select().from(jobs).where(eq(jobs.seriesId, out[0].seriesId!));
    expect(rows.filter((r) => r.title === "Renamed")).toHaveLength(4);
    expect(rows.filter((r) => r.title === "Series edit")).toHaveLength(2);
  });

  test("a recurrence on an existing job joins it to a new series", async () => {
    const src = await run((tx) => createJob(coord, tx, base({ title: "Sundays", startAt: agencyInstant(2035, 10, 7, 7, 30), endAt: agencyInstant(2035, 10, 7, 12, 0) })));
    const out = await run((tx) => createRecurringJobs(coord, tx, src.id, { kind: "weekly", every: 1, weekdays: [0], end: { count: 3 } }));
    expect(out).toHaveLength(2);
    const [after] = await get().db.select().from(jobs).where(eq(jobs.id, src.id));
    expect(after.seriesId).toBeTruthy();
    expect(new Set(out.map((j) => j.seriesId))).toEqual(new Set([after.seriesId]));
    expect(out.map((j) => agencyDateParts(j.startAt).hour)).toEqual([7, 7]);
    const log = await get().db.select().from(auditLog).where(eq(auditLog.entityId, after.seriesId!));
    expect(log.map((a) => a.action)).toEqual(["series.created"]);
  });
});
