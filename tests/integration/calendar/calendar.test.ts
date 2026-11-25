import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, jobPositions, jobs, users } from "@/db/schema";
import { signUp } from "@/domain/assignments/signup";
import { calendarEntries, detailCards, filterOptions, getFilterPrefs, NO_FILTERS, saveFilterPrefs, saveViewFilters } from "@/domain/calendar/calendar";
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
    expect((await get().db.select().from(auditLog).where(eq(auditLog.action, "user.detail_filters"))).length).toBe(2);
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
    const f = await setupFixture(get().db, "cal9");
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
