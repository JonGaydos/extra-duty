import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, jobPositions, jobs, jobTypes, users, vendorLocations, vendors, vendorTypes } from "@/db/schema";
import { signUp } from "@/domain/assignments/signup";
import { calendarEntries, detailCards, filterOptions, getFilterPrefs, listedDay, NO_FILTERS, saveFilterPrefs, saveViewFilters } from "@/domain/calendar/calendar";
import { activeCount, resolveFilters } from "@/app/(app)/_shared/detail-filters";
import { ForbiddenError } from "@/domain/errors";
import { agencyInstant } from "@/domain/time/agency-time";
import { makeUser } from "../users/helpers";
import { setupFixture, HOUR } from "../assignments/helpers";

const range = { from: agencyInstant(2035, 3, 1, 0, 0), to: agencyInstant(2035, 5, 1, 0, 0) };
const NOW = agencyInstant(2035, 2, 20, 12, 0);

describe("agency calendar", () => {
  const get = useTestDb();
  useEmailQueue(get);

  test("staff see every detail with its status, requests included; personnel never see requests or others' held details", async () => {
    const f = await setupFixture(get().db, "cal1");
    const open = await f.mkJob({ count: 2 });
    const full = await f.mkJob({ count: 1 });
    const held = await f.mkJob();
    const req = await f.mkJob();
    const canceled = await f.mkJob();
    const later = await f.mkJob();
    const p = await f.person();
    const other = await f.person();
    await f.run((tx) => signUp(p, tx, full.positionId, { warningVersion: 1 }));
    await get().db.update(jobs).set({ held: true }).where(eq(jobs.id, held.job.id));
    await get().db.update(jobs).set({ state: "requested" }).where(eq(jobs.id, req.job.id));
    await get().db.update(jobs).set({ state: "canceled" }).where(eq(jobs.id, canceled.job.id));
    await get().db.update(jobs).set({ releaseAt: agencyInstant(2035, 3, 1, 0, 0) }).where(eq(jobs.id, later.job.id));

    const staff = await f.run((tx) => calendarEntries(f.coord, tx, range, NO_FILTERS, NOW));
    const status = (id: string) => staff.entries.find((e) => e.id === id)?.status;
    expect(status(open.job.id)).toBe("open");
    expect(status(full.job.id)).toBe("filled");
    expect(status(held.job.id)).toBe("not_released");
    expect(status(req.job.id)).toBe("requested");
    expect(status(canceled.job.id)).toBe("canceled");
    expect(status(later.job.id)).toBe("not_released");

    const seen = (await f.run((tx) => calendarEntries(other, tx, range, NO_FILTERS, NOW))).entries.map((e) => e.id);
    expect(seen).toContain(open.job.id);
    expect(seen).not.toContain(req.job.id);
    expect(seen).not.toContain(held.job.id);

    const mineOnly = await f.run((tx) => calendarEntries(p, tx, range, { ...NO_FILTERS, mine: true }, NOW));
    expect(mineOnly.entries.map((e) => e.id)).toEqual([full.job.id]);
    expect(mineOnly.entries[0].mine).toBe(true);
  });

  test("filters by status, vendor, person, job number and text", async () => {
    const f = await setupFixture(get().db, "cal2");
    const a = await f.mkJob({ count: 2 });
    const b = await f.mkJob({ vendor: f.otherVendorId });
    const p = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1 }));
    const ids = async (filters: Partial<typeof NO_FILTERS>) => (await f.run((tx) => calendarEntries(f.coord, tx, range, { ...NO_FILTERS, vendorIds: [f.vendorId, f.otherVendorId], ...filters }, NOW))).entries.map((e) => e.id);
    expect(await ids({ vendorIds: [f.otherVendorId] })).toEqual([b.job.id]);
    expect(await ids({ personId: p.userId })).toEqual([a.job.id]);
    expect(await ids({ jobNumber: b.job.number })).toEqual([b.job.id]);
    expect(await ids({ q: "cal2 other" })).toEqual([b.job.id]);
    expect(await ids({ statuses: ["filled"] })).toEqual([]);
  });

  test("filters by vendor type, detail type, location, a #number and the description, and keeps rows missing the field out", async () => {
    const f = await setupFixture(get().db, "calf");
    const { db } = get();
    const a = await f.mkJob();
    const b = await f.mkJob({ vendor: f.otherVendorId });
    const [vt] = await db.insert(vendorTypes).values({ name: "calf School" }).returning();
    await db.update(vendors).set({ typeId: vt.id }).where(eq(vendors.id, f.vendorId));
    const [loc] = await db.insert(vendorLocations).values({ vendorId: f.vendorId, name: "calf North lot" }).returning();
    const [otherType] = await db.insert(jobTypes).values({ name: "calf Traffic" }).returning();
    await db.update(jobs).set({ locationId: loc.id, description: "Bring a reflective vest" }).where(eq(jobs.id, a.job.id));
    await db.update(jobs).set({ typeId: otherType.id }).where(eq(jobs.id, b.job.id));
    const ids = async (filters: Partial<typeof NO_FILTERS>) =>
      (await f.run((tx) => calendarEntries(f.coord, tx, range, { ...NO_FILTERS, vendorIds: [f.vendorId, f.otherVendorId], ...filters }, NOW))).entries.map((e) => e.id);
    expect(await ids({ vendorTypeIds: [vt.id] })).toEqual([a.job.id]);
    expect(await ids({ typeIds: [otherType.id] })).toEqual([b.job.id]);
    expect(await ids({ locationIds: [loc.id] })).toEqual([a.job.id]);
    expect(await ids({ q: `#${b.job.number}` })).toEqual([b.job.id]);
    expect(await ids({ q: String(a.job.number) })).toEqual([a.job.id]);
    expect(await ids({ q: "REFLECTIVE" })).toEqual([a.job.id]);
    expect(await ids({ q: "north lot" })).toEqual([a.job.id]);
    expect(await ids({ q: "#99999999" })).toEqual([]);
  });

  test("filter choices for personnel come from what they can see", async () => {
    const f = await setupFixture(get().db, "cal3");
    await f.mkJob();
    const p = await f.person();
    const opts = await f.run((tx) => filterOptions(p, tx, range));
    // Earlier tests' vendors are visible too; the one with no details is not offered.
    expect(opts.vendors.map((v) => v.id)).toContain(f.vendorId);
    expect(opts.vendors.map((v) => v.id)).not.toContain(f.otherVendorId);
    expect(opts.statuses).not.toContain("requested");
  });

  test("filters are saved per person only; vendors are refused", async () => {
    const f = await setupFixture(get().db, "cal4");
    const p = await f.person();
    const q = await f.person();
    await f.run((tx) => saveFilterPrefs(p, tx, { mine: true, remember: true, filters: { ...NO_FILTERS, q: "parade" } }));
    expect(await f.run((tx) => getFilterPrefs(p, tx))).toEqual({ mine: true, remember: true, filters: { ...NO_FILTERS, q: "parade" }, personal: null });
    expect(await f.run((tx) => getFilterPrefs(q, tx))).toEqual({ mine: false, remember: false, filters: null, personal: null });
    // Not remembering drops the filters but keeps My details only.
    await f.run((tx) => saveFilterPrefs(p, tx, { mine: true, remember: false, filters: { ...NO_FILTERS, q: "parade" } }));
    expect(await f.run((tx) => getFilterPrefs(p, tx))).toEqual({ mine: true, remember: false, filters: null, personal: null });
    expect(await get().db.select().from(auditLog).where(eq(auditLog.action, "user.detail_filters"))).toHaveLength(2);
    const v = await makeUser(get().db, "vendor", "cal4-vendor@example.test", { vendorId: f.vendorId } as Partial<typeof users.$inferInsert>);
    await expect(f.run((tx) => calendarEntries({ ...v.actor, vendorId: f.vendorId }, tx, range, NO_FILTERS, NOW))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a person on a detail sees their own position's pay, like their job card", async () => {
    const f = await setupFixture(get().db, "cal5");
    const { job } = await f.mkJob();
    const [ic] = await get().db.insert(jobPositions).values({ jobId: job.id, positionTypeId: f.pos["Incident Commander"], count: 1, rateDifferentialCents: 2500 }).returning();
    const p = await f.person();
    const other = await f.person();
    await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: ic.id, userId: p.userId, status: "signed_up" });
    const mine = (await f.run((tx) => calendarEntries(p, tx, range, { ...NO_FILTERS, vendorIds: [f.vendorId] }, NOW))).entries.find((e) => e.id === job.id)!;
    expect(mine.pay.rateCents).toBe(9500);
    expect(mine.pay.maxRateCents).toBe(9500);
    const theirs = (await f.run((tx) => calendarEntries(other, tx, range, { ...NO_FILTERS, vendorIds: [f.vendorId] }, NOW))).entries.find((e) => e.id === job.id)!;
    expect(theirs.pay.rateCents).toBe(7000);
    expect(theirs.pay.maxRateCents).toBe(9500);
  });

  test("the personnel Details list uses the same filters: cards for what they may see, filtered", async () => {
    const f = await setupFixture(get().db, "cal6");
    const a = await f.mkJob({ count: 2 });
    const b = await f.mkJob({ vendor: f.otherVendorId });
    const req = await f.mkJob();
    await get().db.update(jobs).set({ state: "requested" }).where(eq(jobs.id, req.job.id));
    const p = await f.person();
    const on = await f.person();
    await f.run((tx) => signUp(on, tx, a.positionId, { warningVersion: 1 }));
    const ids = async (filters: Partial<typeof NO_FILTERS>) =>
      (await f.run((tx) => detailCards(p, tx, range, { ...NO_FILTERS, vendorIds: [f.vendorId, f.otherVendorId], ...filters }, NOW))).cards.map((c) => c.id);
    expect(await ids({})).toEqual([a.job.id, b.job.id]);
    expect(await ids({ personId: on.userId })).toEqual([a.job.id]);
    expect(await ids({ q: `#${b.job.number}` })).toEqual([b.job.id]);
    expect(await ids({ statuses: ["filled"] })).toEqual([]);
  });

  test("deputy-only filters: open only, this week, flexible times, workable and sort, saved per person", async () => {
    const f = await setupFixture(get().db, "cal7");
    const cheap = await f.mkJob({ count: 1 });
    const dear = await f.mkJob({ count: 1 });
    const full = await f.mkJob({ count: 1 });
    await get().db.update(jobs).set({ rateCents: 9900 }).where(eq(jobs.id, dear.job.id));
    await get().db.update(jobs).set({ flexEarliestStartAt: new Date(cheap.job.startAt.getTime() - HOUR), flexLatestEndAt: new Date(cheap.job.endAt.getTime() + HOUR) }).where(eq(jobs.id, cheap.job.id));
    const p = await f.person();
    const other = await f.person();
    await f.run((tx) => signUp(other, tx, full.positionId, { warningVersion: 1 }));
    const base = { ...NO_FILTERS, vendorIds: [f.vendorId] };
    const ids = async (filters: Partial<typeof NO_FILTERS>) => (await f.run((tx) => detailCards(p, tx, range, { ...base, ...filters }, NOW))).cards.map((c) => c.id);
    expect(await ids({ openOnly: true })).toEqual([cheap.job.id, dear.job.id]);
    expect(await ids({ flex: true })).toEqual([cheap.job.id]);
    expect(await ids({ sort: "rate" })).toEqual([dear.job.id, cheap.job.id, full.job.id]);
    // This week: none of these 2035 details is in the current week.
    expect(await ids({ week: true })).toEqual([]);
    // No schedule on file: workable keeps them all.
    expect(await ids({ workable: true })).toEqual([cheap.job.id, dear.job.id, full.job.id]);

    const saved = { ...NO_FILTERS, openOnly: true, flex: true, week: true, workable: true, sort: "total_pay" as const };
    await f.run((tx) => saveViewFilters(p, tx, { mine: false, remember: true, filters: saved, personal: true }));
    expect(resolveFilters({}, await f.run((tx) => getFilterPrefs(p, tx)), { personal: true })).toEqual(saved);
  });

  test("the Calendar and Map apply the For you filters like the List: one filter set for every view", async () => {
    const f = await setupFixture(get().db, "cal9");
    const flexOpen = await f.mkJob({ count: 1 });
    const plain = await f.mkJob({ count: 1 });
    const full = await f.mkJob({ count: 1 });
    await get().db.update(jobs).set({ flexEarliestStartAt: new Date(flexOpen.job.startAt.getTime() - HOUR), flexLatestEndAt: new Date(flexOpen.job.endAt.getTime() + HOUR) }).where(eq(jobs.id, flexOpen.job.id));
    const p = await f.person();
    const other = await f.person();
    await f.run((tx) => signUp(other, tx, full.positionId, { warningVersion: 1 }));
    const base = { ...NO_FILTERS, vendorIds: [f.vendorId] };
    const both = async (filters: Partial<typeof NO_FILTERS>) => {
      const list = (await f.run((tx) => detailCards(p, tx, range, { ...base, ...filters }, NOW))).cards.map((c) => c.id).sort((a, b) => a.localeCompare(b));
      const cal = (await f.run((tx) => calendarEntries(p, tx, range, { ...base, ...filters }, NOW))).entries.map((e) => e.id).sort((a, b) => a.localeCompare(b));
      return { list, cal };
    };
    const sorted = (...ids: string[]) => ids.toSorted((a, b) => a.localeCompare(b));
    expect(await both({ openOnly: true })).toEqual({ list: sorted(flexOpen.job.id, plain.job.id), cal: sorted(flexOpen.job.id, plain.job.id) });
    expect(await both({ flex: true })).toEqual({ list: [flexOpen.job.id], cal: [flexOpen.job.id] });
    expect(await both({ week: true })).toEqual({ list: [], cal: [] });
    expect(await both({ workable: true })).toEqual({ list: sorted(flexOpen.job.id, plain.job.id, full.job.id), cal: sorted(flexOpen.job.id, plain.job.id, full.job.id) });
  });

  test("My details only on the Details list also lists the person's canceled sign-ups with the reason", async () => {
    const f = await setupFixture(get().db, "cal8");
    const a = await f.mkJob({ count: 2 });
    const b = await f.mkJob({ count: 2 });
    const p = await f.person();
    await f.run((tx) => signUp(p, tx, a.positionId, { warningVersion: 1 }));
    const gone = await f.run((tx) => signUp(p, tx, b.positionId, { warningVersion: 1 }));
    await get().db.update(assignments).set({ status: "removed", removalReason: "Vendor reduced the headcount" }).where(eq(assignments.id, gone.id));
    const r = await f.run((tx) => detailCards(p, tx, range, { ...NO_FILTERS, mine: true }, NOW));
    expect(r.cards.map((c) => c.id)).toEqual([a.job.id]);
    expect(r.gone.map((g) => [g.job.id, g.reason])).toEqual([[b.job.id, "Vendor reduced the headcount"]]);
  });

  test("each view counts and saves only the filters it shows", async () => {
    const f = await setupFixture(get().db, "calx");
    const p = await f.person();
    // On /jobs the deputy remembers a search and two deputy-only filters.
    await f.run((tx) => saveViewFilters(p, tx, { mine: false, remember: true, filters: { ...NO_FILTERS, q: "parade", openOnly: true, sort: "rate" }, personal: true }));
    let prefs = await f.run((tx) => getFilterPrefs(p, tx));
    // The Calendar shows the search but not the deputy-only filters, and does not count them.
    const onCalendar = resolveFilters({}, prefs, { personal: false });
    expect(onCalendar).toEqual({ ...NO_FILTERS, q: "parade" });
    expect(activeCount(onCalendar, false)).toBe(1);
    const onJobs = resolveFilters({}, prefs, { personal: true });
    expect(onJobs).toEqual({ ...NO_FILTERS, q: "parade", openOnly: true, sort: "rate" });
    expect(activeCount(onJobs, true)).toBe(3);
    // Saving on the Calendar changes the search and leaves the deputy-only filters as they were.
    await f.run((tx) => saveViewFilters(p, tx, { mine: false, remember: true, filters: { ...NO_FILTERS, q: "fair" }, personal: false }));
    prefs = await f.run((tx) => getFilterPrefs(p, tx));
    expect(resolveFilters({}, prefs, { personal: true })).toEqual({ ...NO_FILTERS, q: "fair", openOnly: true, sort: "rate" });
    // Turning Remember off on the Calendar keeps them too; Reset on /jobs clears them.
    await f.run((tx) => saveViewFilters(p, tx, { mine: false, remember: false, filters: NO_FILTERS, personal: false }));
    prefs = await f.run((tx) => getFilterPrefs(p, tx));
    expect(resolveFilters({}, prefs, { personal: true })).toEqual({ ...NO_FILTERS, openOnly: true, sort: "rate" });
    await f.run((tx) => saveViewFilters(p, tx, { mine: false, remember: false, filters: NO_FILTERS, personal: true }));
    prefs = await f.run((tx) => getFilterPrefs(p, tx));
    expect(resolveFilters({}, prefs, { personal: true })).toEqual(NO_FILTERS);
  });
});

describe("details still running after agency midnight", () => {
  const get = useTestDb();
  useEmailQueue(get);

  /** A detail with the given span, with `on` signed up while it was still ahead. */
  async function detailAt(f: Awaited<ReturnType<typeof setupFixture>>, startAt: Date, endAt: Date, on?: Awaited<ReturnType<typeof f.person>>) {
    const d = await f.mkJob({ count: 2 });
    if (on) await f.run((tx) => signUp(on, tx, d.positionId, { warningVersion: 1 }));
    await get().db.update(jobs).set({ startAt, endAt }).where(eq(jobs.id, d.job.id));
    return d.job.id;
  }
  const DAY = 86_400_000;

  test("at 1 AM, today's lists include a detail that started at 10 PM and runs to 2 AM, and leave out one that ended", async () => {
    const f = await setupFixture(get().db, "night");
    const deputy = await f.person();
    const other = await f.person();
    const running = await detailAt(f, agencyInstant(2035, 6, 9, 22, 0), agencyInstant(2035, 6, 10, 2, 0), deputy);
    // Ended at 00:30, before now: never listed.
    await detailAt(f, agencyInstant(2035, 6, 9, 20, 0), agencyInstant(2035, 6, 10, 0, 30), deputy);
    const now = agencyInstant(2035, 6, 10, 1, 0);
    const midnight = agencyInstant(2035, 6, 10, 0, 0);
    const today = { from: midnight, to: new Date(midnight.getTime() + 60 * DAY), runningAt: now };

    // The calendar's list and today's day view start at agency midnight.
    const staff = (await f.run((tx) => calendarEntries(f.coord, tx, today, NO_FILTERS, now))).entries;
    expect(staff.map((e) => e.id)).toEqual([running]);
    expect(staff[0].status).not.toBe("past");
    expect(listedDay(staff[0].startAt, today.from)).toBe("2035-06-10");
    // The coordinator Details list starts now.
    const upcoming = { from: now, to: new Date(now.getTime() + 730 * DAY), runningAt: now };
    expect((await f.run((tx) => calendarEntries(f.coord, tx, upcoming, NO_FILTERS, now))).entries.map((e) => e.id)).toEqual([running]);
    // The deputy's Details list: their own running detail is listed; to anyone else it has started and is left out.
    const list = { from: now, to: new Date(now.getTime() + 120 * DAY), runningAt: now };
    expect((await f.run((tx) => detailCards(deputy, tx, list, NO_FILTERS, now))).cards.map((c) => c.id)).toEqual([running]);
    expect((await f.run((tx) => detailCards(other, tx, list, NO_FILTERS, now))).cards.map((c) => c.id)).toEqual([]);
    // Without runningAt (the month grid, by start day) nothing changes: the detail stays on the day it started.
    const grid = { from: midnight, to: new Date(midnight.getTime() + 35 * DAY) };
    expect((await f.run((tx) => calendarEntries(f.coord, tx, grid, NO_FILTERS, now))).entries).toEqual([]);
  });

  test("across both DST changes, a detail running past midnight stays on today's list until it ends", async () => {
    const f = await setupFixture(get().db, "dst");
    // Fall back (2035-11-04): 01:00 to 02:00 happens twice. 22:00 CDT to 02:00 CST is five hours.
    const fall = await detailAt(f, agencyInstant(2035, 11, 3, 22, 0), agencyInstant(2035, 11, 4, 2, 0));
    // Spring forward (2035-03-11): 02:00 to 03:00 is skipped.
    const spring = await detailAt(f, agencyInstant(2035, 3, 10, 22, 0), agencyInstant(2035, 3, 11, 4, 0));
    const ids = async (y: number, m: number, d: number, now: Date) => {
      const midnight = agencyInstant(y, m, d, 0, 0);
      const r = { from: midnight, to: new Date(midnight.getTime() + 60 * DAY), runningAt: now };
      const entries = (await f.run((tx) => calendarEntries(f.coord, tx, r, NO_FILTERS, now))).entries;
      return entries.map((e) => `${e.id}@${listedDay(e.startAt, r.from)}`);
    };
    const firstOneThirty = agencyInstant(2035, 11, 4, 1, 30);
    const secondOneThirty = new Date(firstOneThirty.getTime() + 3_600_000);
    expect(await ids(2035, 11, 4, firstOneThirty)).toEqual([`${fall}@2035-11-04`]);
    expect(await ids(2035, 11, 4, secondOneThirty)).toEqual([`${fall}@2035-11-04`]);
    expect(await ids(2035, 11, 4, agencyInstant(2035, 11, 4, 2, 0))).toEqual([]);
    expect(await ids(2035, 3, 11, agencyInstant(2035, 3, 11, 1, 30))).toEqual([`${spring}@2035-03-11`]);
    expect(await ids(2035, 3, 11, agencyInstant(2035, 3, 11, 3, 30))).toEqual([`${spring}@2035-03-11`]);
    expect(await ids(2035, 3, 11, agencyInstant(2035, 3, 11, 4, 0))).toEqual([]);
  });
});
