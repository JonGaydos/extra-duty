import { beforeAll, describe, expect, test, vi } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { earningsDashboard } from "@/domain/reports/earnings";
import { ForbiddenError, NotFoundError } from "@/domain/errors";
import { at, buildFixture, NOW } from "./helpers";

describe("earningsDashboard", () => {
  const get = useTestDb();
  let fx: Awaited<ReturnType<typeof buildFixture>>;
  const run = <T>(fn: Parameters<ReturnType<typeof get>["db"]["transaction"]>[0] extends (tx: infer X) => unknown ? (tx: X) => Promise<T> : never) => get().db.transaction(fn);

  beforeAll(async () => {
    fx = await buildFixture(get().db, "earn");
  });

  test("this month and this year match hand-computed totals (billed by detail date, paid by deputyPaidAt)", async () => {
    const d = await run((tx) => earningsDashboard(fx.deputy, tx, fx.deputy.userId, NOW));
    // Jan 2027 details: B 42000 (360 min), C 14000 (120), H 7000 (60). Paid in Jan 2027: A 28000 + C 14000.
    expect(d.thisMonth).toEqual({ details: 3, minutes: 540, billedCents: 63000, paidCents: 42000 });
    expect(d.thisYear).toEqual({ details: 3, minutes: 540, billedCents: 63000, paidCents: 42000 });
    // Billed and not paid: B and H. Returned and written off never count.
    expect(d.outstandingCents).toBe(49000);
  });

  test("a December detail paid in January is billed in 2026 and paid in 2027", async () => {
    const d = await run((tx) => earningsDashboard(fx.deputy, tx, fx.deputy.userId, NOW));
    const y2026 = d.byYear.find((y) => y.year === 2026)!;
    const y2027 = d.byYear.find((y) => y.year === 2027)!;
    // 2026 billed: A 28000, D 35000, G 21000 (240 + 300 + 180 min). Paid in 2026: D 35000 + G 21000 (coordinator close).
    expect(y2026).toEqual({ year: 2026, details: 3, minutes: 720, billedCents: 84000, paidCents: 56000 });
    expect(y2027).toEqual({ year: 2027, details: 3, minutes: 540, billedCents: 63000, paidCents: 42000 });
    expect(d.byYear.map((y) => y.year)).toEqual([2027, 2026]);
  });

  test("another deputy's dashboard is separate", async () => {
    const d = await run((tx) => earningsDashboard(fx.deputy2, tx, fx.deputy2.userId, NOW));
    expect(d.thisYear).toEqual({ details: 0, minutes: 0, billedCents: 0, paidCents: 0 });
    expect(d.outstandingCents).toBe(14000);
    expect(d.byYear.find((y) => y.year === 2026)).toEqual({ year: 2026, details: 2, minutes: 180, billedCents: 21000, paidCents: 7000 });
  });

  test("own data for personnel, anyone for coordinators, never for others or vendors", async () => {
    await expect(run((tx) => earningsDashboard(fx.deputy2, tx, fx.deputy.userId, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    const vendor = { ...(await makeUser(get().db, "vendor", "earn-v@example.test")).actor, vendorId: fx.vendorId };
    await expect(run((tx) => earningsDashboard(vendor, tx, fx.deputy.userId, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    const d = await run((tx) => earningsDashboard(fx.coord, tx, fx.deputy.userId, NOW));
    expect(d.thisYear.billedCents).toBe(63000);
    await expect(run((tx) => earningsDashboard(fx.coord, tx, "no-such-user", NOW))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a paid invoice with no paid date and no close event is never given a guessed date", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const person = await fx.person();
    await fx.mkInvoice({ person, start: at(2027, 1, 3, 17), minutes: 60, status: "paid" });
    const d = await run((tx) => earningsDashboard(person, tx, person.userId, NOW));
    expect(d.thisYear).toEqual({ details: 1, minutes: 60, billedCents: 7000, paidCents: 0 });
    expect(d.outstandingCents).toBe(7000);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
