import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { assignments, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { cancelSignup } from "@/domain/assignments/cancel";
import { removePerson } from "@/domain/assignments/coordinator";
import { jobAdmin } from "@/domain/coordinator/views";
import { cancelJob } from "@/domain/jobs/jobs";
import { jobRoster } from "@/domain/personnel/views";

describe("sign-up history on a detail's deputy list", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let avery: Actor;
  let blake: Actor;
  let jobId: string;
  let canceledJobId: string;

  const add = async (who: Actor, positionId: string, id: string, at: Date) =>
    (await get().db.insert(assignments).values({ jobId: id, jobPositionId: positionId, userId: who.userId, status: "signed_up", requestedAt: at }).returning())[0];

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "hist");
    avery = await f.person();
    blake = await f.person();
    await db.update(users).set({ name: "Avery Hist" }).where(eq(users.id, avery.userId));
    await db.update(users).set({ name: "Blake Hist" }).where(eq(users.id, blake.userId));
    await db.update(users).set({ name: "Dana Coord" }).where(eq(users.id, f.coord.userId));
    const { job, positionId } = await f.mkJob({ count: 2 });
    jobId = job.id;
    const first = await add(avery, positionId, job.id, new Date("2026-01-01T10:00:00Z"));
    await f.run((tx) => cancelSignup(avery, tx, first.id, "Family event"));
    const b = await add(blake, positionId, job.id, new Date("2026-01-02T10:00:00Z"));
    await f.run((tx) => removePerson(f.coord, tx, b.id, "Out of uniform"));
    await add(avery, positionId, job.id, new Date("2026-01-03T10:00:00Z"));

    const other = await f.mkJob();
    canceledJobId = other.job.id;
    await add(blake, other.positionId, other.job.id, new Date("2026-01-04T10:00:00Z"));
    await f.run((tx) => cancelJob(f.coord, tx, other.job.id, "Event called off"));
  });

  test("coordinators see every row in time order, ended rows with their label, who, when and why", async () => {
    const admin = await f.run((tx) => jobAdmin(f.coord, tx, jobId));
    expect(admin.roster.map((r) => [r.name, r.label, r.active])).toEqual([
      ["Avery Hist", "Gave away", false],
      ["Blake Hist", "Removed by coordinator", false],
      ["Avery Hist", "Signed up", true],
    ]);
    const [gave, removed, current] = admin.roster;
    expect(gave.ended).toMatchObject({ by: "Avery Hist", reason: "Family event" });
    expect(gave.ended?.at).toBeInstanceOf(Date);
    expect(removed.ended).toMatchObject({ by: "Dana Coord", reason: "Out of uniform" });
    expect(current.ended).toBeNull();
    // Counts use active rows only.
    expect(admin.positions[0]).toMatchObject({ count: 2, filled: 1 });
  });

  test("a detail the agency canceled labels its rows Canceled with the reason", async () => {
    const admin = await f.run((tx) => jobAdmin(f.coord, tx, canceledJobId));
    expect(admin.roster.map((r) => r.label)).toEqual(["Canceled"]);
    expect(admin.roster[0].ended).toMatchObject({ by: "Dana Coord", reason: "Event called off" });
  });

  test("a late_canceled row reads Vendor canceled late", async () => {
    const { job, positionId } = await f.mkJob();
    await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: blake.userId, status: "late_canceled", removalReason: "Rained out" });
    const admin = await f.run((tx) => jobAdmin(f.coord, tx, job.id));
    expect(admin.roster.map((r) => [r.label, r.active])).toEqual([["Vendor canceled late", false]]);
    // No audit row: who is unknown, and when and why come from the row itself.
    expect(admin.roster[0].ended).toMatchObject({ by: null, reason: "Rained out" });
    expect(admin.roster[0].ended?.at).toBeInstanceOf(Date);
  });

  test("personnel see only the current roster, with no reasons", async () => {
    const rows = await f.run((tx) => jobRoster(blake, tx, jobId));
    expect(rows.map((r) => [r.name, r.label])).toEqual([["Avery Hist", "Signed up"]]);
    expect(JSON.stringify(rows)).not.toMatch(/uniform|Family event/);
  });
});
