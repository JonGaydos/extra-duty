import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { jobs } from "@/db/schema";
import { visibleJobIdByNumber, visibleJobNumber } from "@/domain/jobs/detail-number";
import { setupFixture } from "../assignments/helpers";

describe("detail numbers resolve only for people who may see the detail", () => {
  const get = useTestDb();

  test("staff and deputies find a scheduled detail by number and by id; a vendor request stays hidden from deputies", async () => {
    const f = await setupFixture(get().db, "num1");
    const open = await f.mkJob();
    const request = await f.mkJob();
    await get().db.update(jobs).set({ state: "requested" }).where(eq(jobs.id, request.job.id));
    const deputy = await f.person();

    expect(await f.run((tx) => visibleJobIdByNumber(deputy, tx, open.job.number))).toBe(open.job.id);
    expect(await f.run((tx) => visibleJobNumber(deputy, tx, open.job.id))).toBe(open.job.number);
    // Numbers can be guessed: a detail the deputy may not see answers exactly like one that does not exist.
    expect(await f.run((tx) => visibleJobIdByNumber(deputy, tx, request.job.number))).toBeNull();
    expect(await f.run((tx) => visibleJobNumber(deputy, tx, request.job.id))).toBeNull();
    expect(await f.run((tx) => visibleJobIdByNumber(deputy, tx, 999_999_999))).toBeNull();
    expect(await f.run((tx) => visibleJobIdByNumber(f.coord, tx, request.job.number))).toBe(request.job.id);
  });

  test("a vendor resolves only its own details", async () => {
    const f = await setupFixture(get().db, "num2");
    const mine = await f.mkJob();
    const theirs = await f.mkJob({ vendor: f.otherVendorId });
    const vendor = { userId: f.coord.userId, role: "vendor" as const, rankId: null, vendorId: f.vendorId };
    expect(await f.run((tx) => visibleJobIdByNumber(vendor, tx, mine.job.number))).toBe(mine.job.id);
    expect(await f.run((tx) => visibleJobIdByNumber(vendor, tx, theirs.job.number))).toBeNull();
  });
});
