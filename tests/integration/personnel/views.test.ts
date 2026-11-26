import { beforeAll, describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { HOUR, setupFixture } from "../assignments/helpers";
import type { Actor } from "@/domain/actor";
import { signUp } from "@/domain/assignments/signup";
import { cancelJob } from "@/domain/jobs/jobs";
import { capSummary, listAllJobs, loadJobCards, myDetails } from "@/domain/personnel/views";
import { getJob, JOBS_PAGE_SIZE, listJobs } from "@/domain/jobs/jobs";
import { eligibilityFor, watchJob } from "@/domain/assignments/signup";
import { NotFoundError } from "@/domain/errors";
import { eq } from "drizzle-orm";
import { assignments, jobs, vendorLocations } from "@/db/schema";

const SIGNUP_AT = new Date("2035-01-01T12:00:00Z");

describe("personnel views", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let me: Actor;
  let other: Actor;
  let kept: Awaited<ReturnType<typeof f.mkJob>>;
  let canceled: Awaited<ReturnType<typeof f.mkJob>>;

  beforeAll(async () => {
    f = await setupFixture(get().db, "views");
    me = await f.person();
    other = await f.person();
    kept = await f.mkJob({ count: 2 });
    canceled = await f.mkJob();
    await f.run((tx) => signUp(me, tx, kept.positionId, { warningVersion: 1, now: SIGNUP_AT }));
    await f.run((tx) => signUp(other, tx, kept.positionId, { warningVersion: 1, now: SIGNUP_AT }));
    await f.run((tx) => signUp(me, tx, canceled.positionId, { warningVersion: 1, now: SIGNUP_AT }));
    await f.run((tx) => cancelJob(f.coord, tx, canceled.job.id, "Vendor closed for weather", { now: SIGNUP_AT }));
  });

  test("my details show canceled assignments as Canceled, with the reason, for 30 days after the job date", async () => {
    const soon = new Date(canceled.job.startAt.getTime() + 10 * 24 * HOUR);
    const list = await f.run((tx) => myDetails(me, tx, soon));
    const row = list.find((d) => d.job.id === canceled.job.id);
    expect(row).toMatchObject({ status: "canceled", label: "Canceled", reason: "Vendor closed for weather" });
    expect(list.find((d) => d.job.id === kept.job.id)).toMatchObject({ status: "signed_up", label: "Signed up" });

    const later = new Date(canceled.job.startAt.getTime() + 32 * 24 * HOUR);
    const afterwards = await f.run((tx) => myDetails(me, tx, later));
    expect(afterwards.find((d) => d.job.id === canceled.job.id)).toBeUndefined();
  });

  test("a canceled or removed sign-up reads its own reason, or says who ended it", async () => {
    const who = await f.person();
    const put = async (status: "canceled" | "removed", removalReason: string | null) => {
      const { job, positionId } = await f.mkJob();
      await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: who.userId, status, removalReason });
      return job.id;
    };
    const mine = await put("canceled", null);
    const removed = await put("removed", null);
    const withReason = await put("removed", "Out of uniform");
    const list = await f.run((tx) => myDetails(who, tx, SIGNUP_AT));
    const reason = (id: string) => list.find((d) => d.job.id === id)?.reason;
    expect([reason(mine), reason(removed), reason(withReason)]).toEqual(["You canceled this sign-up", "Removed by a coordinator", "Out of uniform"]);
  });

  test("a card is canceled, started, not released, open or full", async () => {
    const card = async (job: { id: string }, now = SIGNUP_AT) => {
      const [row] = await get().db.select().from(jobs).where(eq(jobs.id, job.id));
      return (await f.run((tx) => loadJobCards(me, tx, [row], now)))[0].availability;
    };
    const open = await f.mkJob();
    const full = await f.mkJob();
    await get().db.insert(assignments).values({ jobId: full.job.id, jobPositionId: full.positionId, userId: (await f.person()).userId, status: "signed_up" });
    const held = await f.mkJob();
    await get().db.update(jobs).set({ held: true }).where(eq(jobs.id, held.job.id));
    const declined = await f.mkJob();
    await get().db.update(jobs).set({ state: "declined" }).where(eq(jobs.id, declined.job.id));
    expect(await card(open.job)).toBe("open");
    expect(await card(full.job)).toBe("full");
    expect(await card(held.job)).toBe("not_released");
    expect(await card(canceled.job)).toBe("canceled");
    expect(await card(declined.job)).toBe("canceled");
    expect(await card(open.job, open.job.startAt)).toBe("started");
  });

  test("my details never include another person's assignments", async () => {
    const list = await f.run((tx) => myDetails(other, tx, SIGNUP_AT));
    expect(list.map((d) => d.job.id)).toEqual([kept.job.id]);
  });

  test("job cards carry vendor, pay, staffing and the person's own status", async () => {
    const rows = await f.run((tx) => listJobs(me, tx, { from: new Date("2035-01-01"), to: new Date("2036-01-01") }, 1));
    const cards = await f.run((tx) => loadJobCards(me, tx, rows, SIGNUP_AT));
    const card = cards.find((c) => c.id === kept.job.id)!;
    expect(card.vendorName).toBe("views Vendor");
    expect(card.rateCents).toBe(7000);
    expect(card.totalCents).toBe(42000);
    expect(card.positions).toEqual([expect.objectContaining({ name: "Deputy Sheriff", count: 2, filled: 2, backups: 0 })]);
    expect(card.openSpots).toBe(0);
    expect(card.mine).toBe("signed_up");
    expect(card.released).toBe(true);
  });

  test("cap summary counts the person's hours against the season caps", async () => {
    const at = new Date(kept.job.startAt.getTime() - 2 * HOUR);
    const caps = await f.run((tx) => capSummary(me, tx, at));
    expect(caps.rolling).toEqual({ usedMinutes: 360, limitMinutes: 960 });
    expect(caps.week.limitMinutes).toBeNull();
    expect(caps.week.usedMinutes).toBe(360);
  });

  const WIDE = { from: new Date("2035-01-01"), to: new Date("2036-01-01") };

  test("personnel never see requested or declined jobs; coordinators still do", async () => {
    const requested = await f.mkJob();
    const declined = await f.mkJob();
    await get().db.update(jobs).set({ state: "requested" }).where(eq(jobs.id, requested.job.id));
    await get().db.update(jobs).set({ state: "declined" }).where(eq(jobs.id, declined.job.id));
    const mine = (await f.run((tx) => listAllJobs(me, tx, WIDE))).jobs.map((j) => j.id);
    expect(mine).not.toContain(requested.job.id);
    expect(mine).not.toContain(declined.job.id);
    for (const id of [requested.job.id, declined.job.id]) {
      await expect(f.run((tx) => getJob(me, tx, id))).rejects.toBeInstanceOf(NotFoundError);
      await expect(f.run((tx) => eligibilityFor(me, tx, id))).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(f.run((tx) => watchJob(me, tx, requested.job.id, SIGNUP_AT))).rejects.toBeInstanceOf(NotFoundError);
    const staff = (await f.run((tx) => listAllJobs(f.coord, tx, WIDE))).jobs.map((j) => j.id);
    expect(staff).toEqual(expect.arrayContaining([requested.job.id, declined.job.id]));
    expect((await f.run((tx) => getJob(f.coord, tx, requested.job.id))).state).toBe("requested");
  });

  test("search matches vendor name, location name, job number, title and description", async () => {
    const a = await f.mkJob();
    const [loc] = await get().db.insert(vendorLocations).values({ vendorId: f.otherVendorId, name: "Pelican Pier" }).returning();
    const b = await f.mkJob({ vendor: f.otherVendorId });
    await get().db.update(jobs).set({ locationId: loc.id, title: "Boat launch", description: "Bring a rain jacket" }).where(eq(jobs.id, b.job.id));
    const find = async (text: string) => (await f.run((tx) => listAllJobs(me, tx, { ...WIDE, text }))).jobs.map((j) => j.id);
    expect(await find("views Other")).toContain(b.job.id);
    expect(await find("views Other")).not.toContain(a.job.id);
    expect(await find("pelican")).toEqual([b.job.id]);
    expect(await find("rain jacket")).toEqual([b.job.id]);
    expect(await find("boat")).toEqual([b.job.id]);
    expect(await find(String(a.job.number))).toEqual([a.job.id]);
    expect(await find(`#${a.job.number}`)).toEqual([a.job.id]);
  });

  test("listAllJobs reads past the first page of 50", async () => {
    const before = (await f.run((tx) => listAllJobs(me, tx, WIDE))).jobs.length;
    for (let i = 0; i < JOBS_PAGE_SIZE + 5; i++) await f.mkJob();
    const all = await f.run((tx) => listAllJobs(me, tx, WIDE));
    expect(all.truncated).toBe(false);
    expect(all.jobs).toHaveLength(before + JOBS_PAGE_SIZE + 5);
    expect(new Set(all.jobs.map((j) => j.id)).size).toBe(all.jobs.length);
    expect(await f.run((tx) => listJobs(me, tx, WIDE, 1))).toHaveLength(JOBS_PAGE_SIZE);
  });
});
