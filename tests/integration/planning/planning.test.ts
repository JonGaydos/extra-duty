import { afterEach, beforeAll, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import type { Tx } from "@/db/client";
import { setupFixture } from "../assignments/helpers";
import { auditLog, calendarBusy, calendarFeeds, jobs, jobTypes, notifications, seasons, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assignPerson, restrictFromVendor } from "@/domain/assignments/coordinator";
import { eligibilityFor } from "@/domain/assignments/signup";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { createJob, listJobs, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { CalendarFetchError, setCalendarFetchDeps, type HopResponse } from "@/domain/planning/calendar-fetch";
import { getCalendarFeedStatus, listCalendarBusy, setCalendarFeed, syncCalendarNow } from "@/domain/planning/calendar";
import { getEarningsGoal, hideVendor, listHiddenVendors, setEarningsGoal, unhideVendor } from "@/domain/planning/preferences";
import { goalProgress, recommendationsFor } from "@/domain/planning/recommend";
import { addScheduleException, getWorkSchedule, listScheduleExceptions, removeScheduleException, setWorkSchedule, type WorkScheduleInput } from "@/domain/planning/schedule";
import { createSeason } from "@/domain/caps/seasons";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { watchJob } from "@/domain/assignments/signup";
import { calendarFeedsTick } from "@/jobs/calendar-feeds";
import { SCHEDULE } from "@/jobs/schedule";
import { watchReleaseTick } from "@/jobs/backup-window";
import { decryptSecret } from "@/lib/crypto/secrets";
import { byText } from "@/lib/sort";
import { asAsync } from "../../setup/streams";

// Fake resolvers and requests are async to match the calendar fetch dependencies; they answer at once.

const NOW = agencyInstant(2026, 11, 23, 9, 0);
const at = (m: number, d: number, h: number, min = 0) => agencyInstant(2026, m, d, h, min);
const PUBLIC = "93.184.216.34";
const FEED_URL = "https://outlook.example.com/owa/calendar/secret-token-123/calendar.ics";

const ICS = (title: string) =>
  `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\nBEGIN:VEVENT\r\nUID:a@t\r\nDTSTART:20261201T150000Z\r\nDTEND:20261201T160000Z\r\nSUMMARY:${title}\r\nEND:VEVENT\r\nEND:VCALENDAR`;

const weeklyInput = (over: Partial<WorkScheduleInput> = {}): WorkScheduleInput => ({
  kind: "weekly",
  weekdays: [1, 2, 3, 4, 5],
  shiftStart: "08:00",
  shiftEnd: "17:00",
  bufferMinutes: 0,
  ...over,
});

describe("personal planning", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let typeId: string;
  let hiddenVendorId: string;
  let restrictedVendorId: string;

  const run = <T>(fn: (tx: Tx) => Promise<T>) => get().db.transaction(fn);
  const mk = async (over: Partial<JobInput> & { vendorId?: string } = {}) => {
    const input: JobInput = {
      vendorId: f.vendorId,
      locationId: null,
      typeId,
      title: "Planning detail",
      description: null,
      notes: null,
      startAt: at(11, 24, 18),
      endAt: at(11, 24, 23),
      rateCents: null,
      positions: [{ positionTypeId: f.pos["Deputy Sheriff"], count: 1 }],
      opsPlanRequired: false,
      opsPlanDueAt: null,
      contactName: null,
      contactPhone: null,
      held: false,
      flex: null,
      ...over,
    };
    const job = await run((tx) => createJob(f.coord, tx, input));
    await get().db.update(jobs).set({ state: "active", releaseAt: new Date("2000-01-01") }).where(eq(jobs.id, job.id));
    const positionId = (await get().db.query.jobPositions.findFirst({ where: (p, { eq: e }) => e(p.jobId, job.id) }))!.id;
    return { job, positionId };
  };
  const inbox = async (userId: string, type: string) =>
    (await get().db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)))).length;

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "plan");
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    await db.delete(seasons);
    [{ id: hiddenVendorId }] = await db.insert(vendors).values({ name: "Hidden Vendor", defaultRateCents: 7000 }).returning();
    [{ id: restrictedVendorId }] = await db.insert(vendors).values({ name: "Restricted Vendor", defaultRateCents: 7000 }).returning();
  });

  afterEach(() => setCalendarFetchDeps(null));

  describe("listJobs: onlyWorkable and sorting", () => {
    test("onlyWorkable hides a detail that overlaps the schedule; the schedule never blocks a sign-up", async () => {
      const me = await f.person();
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ shiftStart: "08:00", shiftEnd: "17:00" })));
      const overlap = await mk({ title: "During shift", startAt: at(12, 7, 9), endAt: at(12, 7, 15) });
      const clear = await mk({ title: "After shift", startAt: at(12, 7, 18), endAt: at(12, 7, 22) });
      const weekend = await mk({ title: "Saturday", startAt: at(12, 5, 9), endAt: at(12, 5, 15) });
      const range = { from: at(12, 5, 0), to: at(12, 8, 0) };
      const all = await run((tx) => listJobs(me, tx, range, 1));
      expect(all.map((j) => j.title)).toEqual(["Saturday", "During shift", "After shift"]);
      const workable = await run((tx) => listJobs(me, tx, { ...range, onlyWorkable: true }, 1));
      expect(workable.map((j) => j.title)).toEqual(["Saturday", "After shift"]);
      const e = await run((tx) => eligibilityFor(me, tx, overlap.job.id, NOW));
      expect(e.canSignUp).toBe(true);
      expect(clear.job.id).toBeTruthy();
      expect(weekend.job.id).toBeTruthy();
    });

    test("onlyWorkable counts the travel buffer and imported calendar busy times", async () => {
      const me = await f.person();
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ bufferMinutes: 60 })));
      await mk({ title: "Tight", startAt: at(12, 14, 17, 30), endAt: at(12, 14, 21) });
      await mk({ title: "Roomy", startAt: at(12, 14, 18, 30), endAt: at(12, 14, 22) });
      const range = { from: at(12, 14, 0), to: at(12, 15, 0) };
      expect((await run((tx) => listJobs(me, tx, { ...range, onlyWorkable: true }, 1))).map((j) => j.title)).toEqual(["Roomy"]);
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ bufferMinutes: 15 })));
      expect((await run((tx) => listJobs(me, tx, { ...range, onlyWorkable: true }, 1))).map((j) => j.title)).toEqual(["Tight", "Roomy"]);

      // 7:00 PM to 8:00 PM Central (01:00Z to 02:00Z) on Dec 14 sits inside "Roomy".
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: () => Promise.resolve(okResponse(icsAt("20261215T010000Z", "20261215T020000Z"))) });
      expect((await syncCalendarNow(me, run, NOW)).ok).toBe(true);
      expect(await run((tx) => listJobs(me, tx, { ...range, onlyWorkable: true }, 1))).toEqual([]);
    });

    test("sort by total pay puts 6 h at $75 ($450) before 4 h at $100 ($400); other sorts and directions", async () => {
      const me = await f.person();
      const a = await mk({ title: "Six hours", startAt: at(12, 20, 8), endAt: at(12, 20, 14), rateCents: 7500 });
      const b = await mk({ title: "Four hours", startAt: at(12, 20, 14), endAt: at(12, 20, 18), rateCents: 10000 });
      const range = { from: at(12, 20, 0), to: at(12, 21, 0) };
      const titles = async (sort: NonNullable<Parameters<typeof listJobs>[2]["sort"]>, direction?: "asc" | "desc") =>
        (await run((tx) => listJobs(me, tx, { ...range, sort, direction }, 1))).map((j) => j.title);
      expect(await titles("total_pay", "desc")).toEqual(["Six hours", "Four hours"]);
      expect(await titles("total_pay", "asc")).toEqual(["Four hours", "Six hours"]);
      expect(await titles("rate", "desc")).toEqual(["Four hours", "Six hours"]);
      expect(await titles("rate", "asc")).toEqual(["Six hours", "Four hours"]);
      expect(await titles("date", "desc")).toEqual(["Four hours", "Six hours"]);
      expect(a.job.id).not.toBe(b.job.id);
    });

    test("sort by vendor name and by location", async () => {
      const me = await f.person();
      const { db } = get();
      const { vendorLocations } = await import("@/db/schema");
      const [locA] = await db.insert(vendorLocations).values({ vendorId: f.vendorId, name: "Arena" }).returning();
      const [locZ] = await db.insert(vendorLocations).values({ vendorId: f.vendorId, name: "Zoo" }).returning();
      await mk({ title: "At zoo", startAt: at(12, 22, 8), endAt: at(12, 22, 13), locationId: locZ.id });
      await mk({ title: "At arena", startAt: at(12, 22, 14), endAt: at(12, 22, 19), locationId: locA.id });
      await mk({ title: "Other vendor", startAt: at(12, 22, 20), endAt: at(12, 22, 23), vendorId: f.otherVendorId });
      const range = { from: at(12, 22, 0), to: at(12, 23, 0) };
      const t = async (sort: "vendor" | "location", direction?: "asc" | "desc") => (await run((tx) => listJobs(me, tx, { ...range, sort, direction }, 1))).map((j) => j.title);
      expect(await t("location")).toEqual(["At arena", "At zoo", "Other vendor"]);
      expect(await t("location", "desc")).toEqual(["At zoo", "At arena", "Other vendor"]);
      // "plan Other Vendor" sorts before "plan Vendor"; ties fall back to the start time.
      expect(await t("vendor")).toEqual(["Other vendor", "At zoo", "At arena"]);
      expect(await t("vendor", "desc")).toEqual(["At zoo", "At arena", "Other vendor"]);
    });
  });

  describe("hidden and restricted vendors", () => {
    test("a hidden or restricted vendor's jobs never appear for that deputy; a coordinator can still assign", async () => {
      const me = await f.person();
      const other = await f.person();
      const hidden = await mk({ title: "Hidden one", vendorId: hiddenVendorId, startAt: at(12, 9, 18), endAt: at(12, 9, 23) });
      const restricted = await mk({ title: "Restricted one", vendorId: restrictedVendorId, startAt: at(12, 9, 8), endAt: at(12, 9, 12) });
      await mk({ title: "Normal one", startAt: at(12, 9, 13), endAt: at(12, 9, 17) });
      await run((tx) => hideVendor(me, tx, hiddenVendorId));
      await run((tx) => restrictFromVendor(f.coord, tx, me.userId, restrictedVendorId, { reason: "Test", removeFromFutureDetails: false }));
      const range = { from: at(12, 9, 0), to: at(12, 10, 0) };
      expect((await run((tx) => listJobs(me, tx, range, 1))).map((j) => j.title)).toEqual(["Normal one"]);
      expect((await run((tx) => listJobs(other, tx, range, 1))).map((j) => j.title)).toEqual(["Restricted one", "Normal one", "Hidden one"]);
      expect((await run((tx) => listJobs(f.coord, tx, range, 1))).map((j) => j.title)).toEqual(["Restricted one", "Normal one", "Hidden one"]);

      const row = await run((tx) => assignPerson(f.coord, tx, hidden.positionId, me.userId, { notify: false, now: NOW }));
      expect(row.userId).toBe(me.userId);
      // Details the person is on stay visible in "mine" and in the lists.
      expect((await run((tx) => listJobs(me, tx, { ...range, mine: true }, 1))).map((j) => j.title)).toEqual(["Hidden one"]);
      await expect(run((tx) => assignPerson(f.coord, tx, restricted.positionId, me.userId, { notify: false, now: NOW }))).rejects.toBeInstanceOf(RuleViolation);

      await run((tx) => unhideVendor(me, tx, hiddenVendorId));
      expect(await run((tx) => listHiddenVendors(me, tx, me.userId))).toEqual([]);
    });

    test("a hidden vendor suppresses watch alerts but never alerts about the person's own assignments", async () => {
      const me = await f.person();
      const { job } = await mk({ title: "Watched", vendorId: hiddenVendorId, startAt: at(12, 12, 18), endAt: at(12, 12, 23) });
      const releaseAt = new Date(job.startAt.getTime() - 10 * 24 * 3_600_000);
      await get().db.update(jobs).set({ releaseAt }).where(eq(jobs.id, job.id));
      await run((tx) => watchJob(me, tx, job.id, new Date(releaseAt.getTime() - 24 * 3_600_000)));
      await run((tx) => hideVendor(me, tx, hiddenVendorId));
      const after = new Date(releaseAt.getTime() + 24 * 3_600_000);
      expect((await run((tx) => watchReleaseTick(after, tx))).alerted).toBe(0);
      expect(await inbox(me.userId, "job.watch_released")).toBe(0);
      await run((tx) => unhideVendor(me, tx, hiddenVendorId));
      expect((await run((tx) => watchReleaseTick(after, tx))).alerted).toBe(1);

      // Own assignment alerts still arrive while the vendor is hidden.
      const mine = await mk({ title: "Mine", vendorId: hiddenVendorId, startAt: at(12, 13, 18), endAt: at(12, 13, 23) });
      await run((tx) => assignPerson(f.coord, tx, mine.positionId, me.userId, { notify: false, now: NOW }));
      await run((tx) => hideVendor(me, tx, hiddenVendorId));
      await run((tx) => updateJob(f.coord, tx, mine.job.id, { rateCents: 9900 }, "one"));
      expect(await inbox(me.userId, "job.changed")).toBe(1);
      await run((tx) => unhideVendor(me, tx, hiddenVendorId));
    });
  });

  describe("earnings goal and recommendations", () => {
    test("goal progress counts signed-up pay at billable minutes; recommendations are soonest first, with no hidden or restricted vendors", async () => {
      const me = await f.person();
      const other = await f.person();
      const day1 = await mk({ title: "Nov 25", startAt: at(11, 25, 8), endAt: at(11, 25, 14) });
      await mk({ title: "Nov 26", startAt: at(11, 26, 8), endAt: at(11, 26, 14) });
      await mk({ title: "Nov 27", startAt: at(11, 27, 8), endAt: at(11, 27, 14) });
      await mk({ title: "Hidden", vendorId: hiddenVendorId, startAt: at(11, 24, 8), endAt: at(11, 24, 14) });
      await mk({ title: "Restricted", vendorId: restrictedVendorId, startAt: at(11, 24, 15), endAt: at(11, 24, 21) });
      await mk({ title: "Next year", startAt: agencyInstant(2027, 3, 1, 8, 0), endAt: agencyInstant(2027, 3, 1, 14, 0) });
      await mk({ title: "Held", held: true, startAt: at(11, 28, 8), endAt: at(11, 28, 14) });
      await run((tx) => hideVendor(me, tx, hiddenVendorId));
      await run((tx) => restrictFromVendor(f.coord, tx, me.userId, restrictedVendorId, { reason: "Test", removeFromFutureDetails: false }));

      expect(await run((tx) => goalProgress(me, tx, NOW))).toEqual({ goalCents: null, earnedCents: 0, signedUpCents: 0, remainingCents: 0 });
      expect(await run((tx) => recommendationsFor(me, tx, NOW))).toEqual([]);

      await run((tx) => setEarningsGoal(me, tx, 50_000));
      expect(await run((tx) => getEarningsGoal(me, tx, me.userId))).toBe(50_000);
      const recs = await run((tx) => recommendationsFor(me, tx, NOW));
      // 6 h at $70 = $420 each: two reach the $500 goal.
      expect(recs.map((r) => [r.title, r.totalCents])).toEqual([["Nov 25", 42_000], ["Nov 26", 42_000]]);

      // Signing up counts at billable minutes (a 6 h detail is $420) and leaves $80 to go.
      await run((tx) => assignPerson(f.coord, tx, day1.positionId, me.userId, { notify: false, now: NOW }));
      expect(await run((tx) => goalProgress(me, tx, NOW))).toEqual({ goalCents: 50_000, earnedCents: 0, signedUpCents: 42_000, remainingCents: 8_000 });
      const next = await run((tx) => recommendationsFor(me, tx, NOW));
      expect(next.map((r) => r.title)).toEqual(["Nov 26"]);

      // Another deputy's recommendations are theirs alone.
      expect(await run((tx) => recommendationsFor(other, tx, NOW))).toEqual([]);
    });

    test("a short detail below the minimum is paid at the minimum", async () => {
      const me = await f.person();
      await mk({ title: "Two hours", startAt: at(12, 1, 8), endAt: at(12, 1, 10) });
      await run((tx) => setEarningsGoal(me, tx, 3_000_000));
      const recs = await run((tx) => recommendationsFor(me, tx, NOW));
      expect(recs.find((r) => r.title === "Two hours")?.totalCents).toBe(28_000);
    });

    test("recommendations skip details that overlap the deputy's duty time", async () => {
      const me = await f.person();
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ shiftStart: "00:00", shiftEnd: "23:59", weekdays: [3] })));
      await run((tx) => setEarningsGoal(me, tx, 3_000_000));
      const titles = (await run((tx) => recommendationsFor(me, tx, NOW))).map((r) => r.title);
      expect(titles).toContain("Nov 26");
      expect(titles).not.toContain("Nov 25");
    });

    test("a flexible detail is recommended at times that clear the deputy's duty", async () => {
      const me = await f.person();
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ shiftStart: "06:00", shiftEnd: "09:00", weekdays: [1], bufferMinutes: 0 })));
      const flex = { earliestStartAt: at(11, 30, 6), latestEndAt: at(11, 30, 20), allowShorter: false };
      await mk({ title: "Flex Monday", startAt: at(11, 30, 8), endAt: at(11, 30, 14), flex });
      await mk({ title: "Fixed Monday", startAt: at(11, 30, 8), endAt: at(11, 30, 14) });
      await run((tx) => setEarningsGoal(me, tx, 3_000_000));
      const recs = await run((tx) => recommendationsFor(me, tx, NOW));
      expect(recs.map((r) => r.title)).not.toContain("Fixed Monday");
      const pick = recs.find((r) => r.title === "Flex Monday");
      expect(pick?.placement).toEqual({ startAt: at(11, 30, 9), endAt: at(11, 30, 15) });
    });

    test("goal validation", async () => {
      const me = await f.person();
      await expect(run((tx) => setEarningsGoal(me, tx, -5))).rejects.toBeInstanceOf(ValidationError);
      await expect(run((tx) => setEarningsGoal(me, tx, 10.5))).rejects.toBeInstanceOf(ValidationError);
      await run((tx) => setEarningsGoal(me, tx, 20_000));
      await run((tx) => setEarningsGoal(me, tx, null));
      expect(await run((tx) => getEarningsGoal(me, tx, me.userId))).toBeNull();
    });
  });

  describe("hour caps with the work schedule", () => {
    test("details_plus_schedule adds work shifts (not buffers, not calendar events) to the cap hours", async () => {
      const { db } = get();
      await run((tx) => createSeason(f.coord, tx, { name: "All year", startMonthDay: "01-01", endMonthDay: "12-31", rollingCapMinutes: 960, weekCapMinutes: null, monthCapMinutes: null }));
      const me = await f.person();
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ shiftStart: "06:00", shiftEnd: "18:00", bufferMinutes: 60 })));
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      const overlapping = await mk({ title: "Over the cap", startAt: at(11, 24, 17), endAt: at(11, 24, 23) });
      const exactly = await mk({ title: "Exactly 16", startAt: at(11, 25, 19), endAt: at(11, 25, 23) });
      // Calendar events never count toward caps.
      await db.insert(calendarBusy).values({ feedId: (await db.select().from(calendarFeeds).where(eq(calendarFeeds.userId, me.userId)))[0].id, startAt: at(11, 25, 0), endAt: at(11, 25, 6), title: "Night" });

      const checks = async (id: string) => (await run((tx) => eligibilityFor(me, tx, id, NOW))).checks.filter((c) => !c.ok).map((c) => c.check);
      expect(await checks(overlapping.job.id)).toEqual([]);
      expect(await checks(exactly.job.id)).toEqual([]);

      await run((tx) => updateSettings(f.coord, tx, { capHoursMode: "details_plus_schedule" }));
      expect(await checks(overlapping.job.id)).toEqual(["cap_rolling"]);
      expect(await checks(exactly.job.id)).toEqual([]);
      await run((tx) => updateSettings(f.coord, tx, { capHoursMode: "details_only" }));
    });
  });

  describe("privacy", () => {
    test("nobody else can read or change a deputy's planning data, coordinators included; audit rows hold no details", async () => {
      const me = await f.person();
      const other = await f.person();
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ shiftStart: "07:13", shiftEnd: "16:41" })));
      await run((tx) => addScheduleException(me, tx, { date: "2026-12-24", kind: "extra", shiftStart: "09:17", shiftEnd: "11:19" }));
      await run((tx) => hideVendor(me, tx, hiddenVendorId));
      await run((tx) => setEarningsGoal(me, tx, 123_456));
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: () => Promise.resolve(okResponse(ICS("Dentist appointment"))) });
      expect((await syncCalendarNow(me, run, NOW)).ok).toBe(true);

      for (const viewer of [other, f.coord]) {
        await expect(run((tx) => getWorkSchedule(viewer, tx, me.userId))).rejects.toBeInstanceOf(ForbiddenError);
        await expect(run((tx) => listScheduleExceptions(viewer, tx, me.userId))).rejects.toBeInstanceOf(ForbiddenError);
        await expect(run((tx) => listHiddenVendors(viewer, tx, me.userId))).rejects.toBeInstanceOf(ForbiddenError);
        await expect(run((tx) => getEarningsGoal(viewer, tx, me.userId))).rejects.toBeInstanceOf(ForbiddenError);
        await expect(run((tx) => listCalendarBusy(viewer, tx, me.userId))).rejects.toBeInstanceOf(ForbiddenError);
        await expect(run((tx) => getCalendarFeedStatus(viewer, tx, me.userId))).rejects.toBeInstanceOf(ForbiddenError);
      }
      const vendorActor: Actor = { userId: "v", role: "vendor", rankId: null, vendorId: f.vendorId };
      await expect(run((tx) => setWorkSchedule(vendorActor, tx, weeklyInput()))).rejects.toBeInstanceOf(ForbiddenError);

      expect((await run((tx) => getWorkSchedule(me, tx, me.userId)))?.shiftStart).toBe("07:13");
      expect((await run((tx) => listCalendarBusy(me, tx, me.userId))).map((b) => b.title)).toEqual(["Dentist appointment"]);

      const rows = await get().db.select().from(auditLog).where(eq(auditLog.actorUserId, me.userId));
      expect(rows.length).toBeGreaterThanOrEqual(5);
      const dump = JSON.stringify(rows);
      for (const secret of ["07:13", "16:41", "09:17", "11:19", "Dentist", hiddenVendorId, "123456", "secret-token-123", "outlook.example.com"]) {
        expect(dump).not.toContain(secret);
      }
      const planning = rows.filter((r) => r.action.startsWith("planning."));
      expect(planning.map((r) => r.action).sort(byText)).toEqual(
        ["planning.calendar_feed_set", "planning.calendar_sync", "planning.earnings_goal_set", "planning.exception_add", "planning.schedule_set", "planning.vendor_hide"].sort(byText),
      );
      for (const r of planning) expect(r.entityId).toBe(me.userId);
    });

    test("schedule input is validated", async () => {
      const me = await f.person();
      const bad = (over: Partial<WorkScheduleInput>) => expect(run((tx) => setWorkSchedule(me, tx, weeklyInput(over)))).rejects.toBeInstanceOf(ValidationError);
      await bad({ bufferMinutes: 20 });
      await bad({ shiftStart: "25:00" });
      await bad({ weekdays: [] });
      await bad({ weekdays: [7] });
      await bad({ kind: "rotation", weekdays: undefined, cycle: "1102", anchorDate: "2026-11-02" });
      await bad({ kind: "rotation", weekdays: undefined, cycle: "1100", anchorDate: "2026-02-31" });
      await expect(run((tx) => addScheduleException(me, tx, { date: "2026-12-24", kind: "extra" }))).rejects.toBeInstanceOf(ValidationError);
      await expect(run((tx) => addScheduleException(me, tx, { date: "12/24/2026", kind: "off" }))).rejects.toBeInstanceOf(ValidationError);
    });

    test("setting the schedule again replaces it; null turns it off", async () => {
      const me = await f.person();
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ shiftStart: "06:00" })));
      await run((tx) => setWorkSchedule(me, tx, weeklyInput({ shiftStart: "10:00" })));
      expect((await run((tx) => getWorkSchedule(me, tx, me.userId)))?.shiftStart).toBe("10:00");
      await run((tx) => setWorkSchedule(me, tx, null));
      expect((await run((tx) => getWorkSchedule(me, tx, me.userId)))?.active).toBe(false);
    });
  });

  describe("calendar feed", () => {
    const okRequest = (text: string) => () => Promise.resolve(okResponse(text));

    test("the link is stored encrypted and https only; webcal is accepted", async () => {
      const me = await f.person();
      await expect(run((tx) => setCalendarFeed(me, tx, "http://example.com/a.ics"))).rejects.toBeInstanceOf(ValidationError);
      await run((tx) => setCalendarFeed(me, tx, "webcal://outlook.example.com/cal.ics"));
      const [feed] = await get().db.select().from(calendarFeeds).where(eq(calendarFeeds.userId, me.userId));
      expect(feed.urlEnc).not.toContain("outlook.example.com");
      expect(decryptSecret(feed.urlEnc!)).toBe("https://outlook.example.com/cal.ics");
      const status = await run((tx) => getCalendarFeedStatus(me, tx, me.userId));
      expect(status).toEqual({ connected: true, lastFetchedAt: null, lastError: null });
      await run((tx) => setCalendarFeed(me, tx, null));
      expect(await run((tx) => getCalendarFeedStatus(me, tx, me.userId))).toEqual({ connected: false, lastFetchedAt: null, lastError: null });
    });

    test("a feed that resolves to a private address is refused with a generic error and no connection", async () => {
      const me = await f.person();
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      let connected = false;
      setCalendarFetchDeps({
        resolve: () => Promise.resolve(["10.0.0.5"]),
        request: () => {
          connected = true;
          return Promise.resolve(okResponse(ICS("x")));
        },
      });
      const result = await syncCalendarNow(me, run, NOW);
      expect(result).toEqual({ ok: false, lastError: "Could not fetch the calendar: that address is not allowed" });
      expect(connected).toBe(false);
      const status = await run((tx) => getCalendarFeedStatus(me, tx, me.userId));
      expect(status.lastError).toBe("Could not fetch the calendar: that address is not allowed");
      expect(JSON.stringify(status)).not.toContain("secret-token-123");
    });

    test("success replaces the busy rows; a 500 keeps the previous rows and records the error; sync is limited to once per 15 minutes", async () => {
      const me = await f.person();
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: okRequest(ICS("Court")) });
      expect((await syncCalendarNow(me, run, NOW)).ok).toBe(true);
      expect((await run((tx) => listCalendarBusy(me, tx, me.userId))).map((b) => b.title)).toEqual(["Court"]);

      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: () => Promise.resolve({ status: 500, location: null, body: emptyBody(), close: () => {} }) });
      const early = new Date(NOW.getTime() + 5 * 60_000);
      await expect(syncCalendarNow(me, run, early)).rejects.toMatchObject({
        checks: [expect.objectContaining({ ok: false, message: "You can sync again in 10 minutes" })],
      });
      await expect(syncCalendarNow(me, run, early)).rejects.toBeInstanceOf(RuleViolation);

      const later = new Date(NOW.getTime() + 16 * 60_000);
      const failed = await syncCalendarNow(me, run, later);
      expect(failed).toEqual({ ok: false, lastError: "Could not fetch the calendar: the server answered 500" });
      expect((await run((tx) => listCalendarBusy(me, tx, me.userId))).map((b) => b.title)).toEqual(["Court"]);
      const status = await run((tx) => getCalendarFeedStatus(me, tx, me.userId));
      expect(status.lastError).toBe("Could not fetch the calendar: the server answered 500");

      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: okRequest(ICS("Training")) });
      const third = new Date(later.getTime() + 20 * 60_000);
      expect((await syncCalendarNow(me, run, third)).ok).toBe(true);
      expect((await run((tx) => listCalendarBusy(me, tx, me.userId))).map((b) => b.title)).toEqual(["Training"]);
      expect((await run((tx) => getCalendarFeedStatus(me, tx, me.userId))).lastError).toBeNull();
    });

    test("syncing without a link, and unexpected errors, give short messages", async () => {
      const me = await f.person();
      await expect(syncCalendarNow(me, run, NOW)).rejects.toBeInstanceOf(ValidationError);
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      setCalendarFetchDeps({
        resolve: () => {
          return Promise.reject(new CalendarFetchError("the address could not be found"));
        },
        request: okRequest(""),
      });
      expect(await syncCalendarNow(me, run, NOW)).toEqual({ ok: false, lastError: "Could not fetch the calendar: the address could not be found" });
      const later = new Date(NOW.getTime() + 20 * 60_000);
      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: okRequest("this is not a calendar") });
      expect(await syncCalendarNow(me, run, later)).toEqual({ ok: false, lastError: "Could not fetch the calendar: the file is not a valid calendar" });
    });

    test("calendarFeedsTick syncs every feed, one transaction each, and is scheduled daily at 3:20 AM", async () => {
      const { db } = get();
      await db.delete(calendarBusy);
      await db.delete(calendarFeeds);
      const [a, b] = [await f.person(), await f.person()];
      await run((tx) => setCalendarFeed(a, tx, "https://a.example.com/a.ics"));
      await run((tx) => setCalendarFeed(b, tx, "https://b.example.com/b.ics"));
      setCalendarFetchDeps({
        resolve: (host) => Promise.resolve(host === "b.example.com" ? ["10.1.1.1"] : [PUBLIC]),
        request: okRequest(ICS("From tick")),
      });
      const out = await calendarFeedsTick(NOW, run);
      expect(out).toEqual({ synced: 1, failed: 1 });
      expect((await run((tx) => listCalendarBusy(a, tx, a.userId))).map((x) => x.title)).toEqual(["From tick"]);
      expect((await run((tx) => getCalendarFeedStatus(b, tx, b.userId))).lastError).toBe("Could not fetch the calendar: that address is not allowed");
      const tick = SCHEDULE.find((t) => t.name === "calendar-feeds");
      expect(tick).toMatchObject({ cron: "20 3 * * *", tz: "America/Chicago" });
    });
  });
  describe("fix round 1", () => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

    test("two parallel syncs for one person do one fetch", async () => {
      const me = await f.person();
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      let fetches = 0;
      setCalendarFetchDeps({
        resolve: () => Promise.resolve([PUBLIC]),
        request: async () => {
          fetches++;
          await delay(150);
          return okResponse(ICS("Parallel"));
        },
      });
      const results = await Promise.allSettled([syncCalendarNow(me, run, NOW), syncCalendarNow(me, run, NOW), syncCalendarNow(me, run, NOW)]);
      expect(fetches).toBe(1);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      for (const r of results.filter((x) => x.status === "rejected")) expect((r as PromiseRejectedResult).reason).toBeInstanceOf(RuleViolation);
      expect((await run((tx) => listCalendarBusy(me, tx, me.userId))).map((b) => b.title)).toEqual(["Parallel"]);
    });

    test("no transaction is open while the calendar is fetched", async () => {
      const me = await f.person();
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      let locked: boolean | null = null;
      setCalendarFetchDeps({
        resolve: () => Promise.resolve([PUBLIC]),
        request: async () => {
          // If the feed row were still locked, this update (on another connection) would block until the fetch ended.
          const t = Date.now();
          await get().db.update(calendarFeeds).set({ lastError: null }).where(eq(calendarFeeds.userId, me.userId));
          locked = Date.now() - t > 1000;
          return okResponse(ICS("Free of locks"));
        },
      });
      expect((await syncCalendarNow(me, run, NOW)).ok).toBe(true);
      expect(locked).toBe(false);
    });

    test("setting or removing the link does not reset the 15-minute sync limit", async () => {
      const me = await f.person();
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: () => Promise.resolve(okResponse(ICS("Once"))) });
      expect((await syncCalendarNow(me, run, NOW)).ok).toBe(true);
      const soon = new Date(NOW.getTime() + 60_000);
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      await expect(syncCalendarNow(me, run, soon)).rejects.toBeInstanceOf(RuleViolation);
      await run((tx) => setCalendarFeed(me, tx, "https://other.example.com/cal.ics"));
      await expect(syncCalendarNow(me, run, soon)).rejects.toBeInstanceOf(RuleViolation);
      await run((tx) => setCalendarFeed(me, tx, null));
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      await expect(syncCalendarNow(me, run, soon)).rejects.toBeInstanceOf(RuleViolation);
      expect((await syncCalendarNow(me, run, new Date(NOW.getTime() + 16 * 60_000))).ok).toBe(true);
    });

    test("a large feed is stored in batches; an oversized one is refused and keeps the old rows", async () => {
      const me = await f.person();
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      const many = (n: number) =>
        "BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\n" +
        Array.from({ length: n }, (_, i) => `BEGIN:VEVENT\r\nUID:e${i}@t\r\nDTSTART:20261201T${String(Math.floor(i / 60) % 24).padStart(2, "0")}${String(i % 60).padStart(2, "0")}00Z\r\nDTEND:20261201T${String(Math.floor(i / 60) % 24).padStart(2, "0")}${String(i % 60).padStart(2, "0")}30Z\r\nSUMMARY:E${i}\r\nEND:VEVENT\r\n`).join("") +
        "END:VCALENDAR";
      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: () => Promise.resolve(okResponse(many(1200))) });
      expect((await syncCalendarNow(me, run, NOW)).ok).toBe(true);
      expect(await run((tx) => listCalendarBusy(me, tx, me.userId))).toHaveLength(1200);

      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: () => Promise.resolve(okResponse(many(5001))) });
      const later = new Date(NOW.getTime() + 20 * 60_000);
      expect(await syncCalendarNow(me, run, later)).toEqual({ ok: false, lastError: "Could not fetch the calendar: the calendar is too large" });
      expect(await run((tx) => listCalendarBusy(me, tx, me.userId))).toHaveLength(1200);
    });

    test("an unexpected failure is logged by name only and shown generically", async () => {
      const me = await f.person();
      await run((tx) => setCalendarFeed(me, tx, FEED_URL));
      // A link that cannot be decrypted (for example after a key change).
      await get().db.update(calendarFeeds).set({ urlEnc: "not-a-valid-secret" }).where(eq(calendarFeeds.userId, me.userId));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      expect(await syncCalendarNow(me, run, NOW)).toEqual({ ok: false, lastError: "Could not fetch the calendar: something went wrong" });
      expect(log).toHaveBeenCalledWith("Calendar sync failed unexpectedly: Error");
      expect(JSON.stringify(log.mock.calls)).not.toContain("not-a-valid-secret");
      log.mockRestore();
    });

    test("a feed that throws in the tick is counted as failed and the next feed still syncs", async () => {
      const { db } = get();
      await db.delete(calendarBusy);
      await db.delete(calendarFeeds);
      const [a, b] = [await f.person(), await f.person()];
      await run((tx) => setCalendarFeed(a, tx, "https://a.example.com/a.ics"));
      await run((tx) => setCalendarFeed(b, tx, "https://b.example.com/b.ics"));
      setCalendarFetchDeps({ resolve: () => Promise.resolve([PUBLIC]), request: () => Promise.resolve(okResponse(ICS("Second feed"))) });
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      let calls = 0;
      // Call 1 lists the feeds; 2 and 3 are the first feed's read and write. Fail the write.
      const flaky: typeof run = (fn) => (++calls === 3 ? Promise.reject(new Error("database went away")) : run(fn));
      expect(await calendarFeedsTick(NOW, flaky)).toEqual({ synced: 1, failed: 1 });
      expect(log).toHaveBeenCalledWith("Calendar feed sync failed: Error");
      log.mockRestore();
      expect((await run((tx) => listCalendarBusy(b, tx, b.userId))).map((x) => x.title)).toEqual(["Second feed"]);
    });

    test("removeScheduleException removes the owner's exception; others get not found", async () => {
      const me = await f.person();
      const other = await f.person();
      const ex = await run((tx) => addScheduleException(me, tx, { date: "2026-12-30", kind: "off" }));
      await expect(run((tx) => removeScheduleException(other, tx, ex.id))).rejects.toBeInstanceOf(NotFoundError);
      await expect(run((tx) => removeScheduleException(f.coord, tx, ex.id))).rejects.toBeInstanceOf(NotFoundError);
      await run((tx) => removeScheduleException(me, tx, ex.id));
      expect(await run((tx) => listScheduleExceptions(me, tx, me.userId))).toEqual([]);
      await expect(run((tx) => removeScheduleException(me, tx, ex.id))).rejects.toBeInstanceOf(NotFoundError);
    });

    test("extra shifts count toward the cap hours and the list filter even with no active pattern", async () => {
      const me = await f.person();
      await run((tx) => addScheduleException(me, tx, { date: "2027-01-12", kind: "extra", shiftStart: "08:00", shiftEnd: "16:00" }));
      const job = await mk({ title: "During extra", startAt: agencyInstant(2027, 1, 12, 10, 0), endAt: agencyInstant(2027, 1, 12, 14, 0) });
      const range = { from: agencyInstant(2027, 1, 12, 0, 0), to: agencyInstant(2027, 1, 13, 0, 0) };
      expect((await run((tx) => listJobs(me, tx, { ...range, onlyWorkable: true }, 1))).map((j) => j.id)).not.toContain(job.job.id);
    });

    test("onlyWorkable needs a bounded date range", async () => {
      const me = await f.person();
      await expect(run((tx) => listJobs(me, tx, { from: new Date(0), to: new Date("9999-12-31"), onlyWorkable: true }, 1))).rejects.toBeInstanceOf(ValidationError);
    });
  });
});

function emptyBody(): AsyncIterable<Uint8Array> {
  return { async *[Symbol.asyncIterator]() {} };
}
function okResponse(text: string): HopResponse {
  return {
    status: 200,
    location: null,
    body: asAsync([new TextEncoder().encode(text)]),
    close: () => {},
  };
}
function icsAt(start: string, end: string): string {
  return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//T//EN\r\nBEGIN:VEVENT\r\nUID:b@t\r\nDTSTART:${start}\r\nDTEND:${end}\r\nSUMMARY:Zero\r\nEND:VEVENT\r\nEND:VCALENDAR`;
}
