import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { files, jobs, opsPlanVersions, opsPlans, vendorLocations, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { searchLibrary, suggestPriorPlan } from "@/domain/ops-plans/library";
import { agencyInstant } from "@/domain/time/agency-time";

const HOUR = 3_600_000;

describe("ops plan library", () => {
  const get = useTestDb();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let n = 0;
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);

  beforeAll(async () => {
    fx = await setupFixture(get().db, "lib");
    admin = (await makeUser(get().db, "admin", "lib-admin@example.test")).actor;
  });

  /** A past job with an ops plan whose one version has the given decision. */
  async function mkPlan(title: string, o: { vendorId?: string; startAt: Date; decision?: "agreed" | "denied" | "pending"; locationId?: string | null; location?: string | null }) {
    const { db } = get();
    const { job } = await fx.mkJob({ vendor: o.vendorId });
    await db
      .update(jobs)
      .set({ title, startAt: o.startAt, endAt: new Date(o.startAt.getTime() + 6 * HOUR), locationId: o.locationId ?? null })
      .where(eq(jobs.id, job.id));
    const decision = o.decision ?? "agreed";
    const [plan] = await db
      .insert(opsPlans)
      .values({ jobId: job.id, vendorId: job.vendorId, eventName: title, year: Number(o.startAt.toISOString().slice(0, 4)), location: o.location ?? null, status: decision === "pending" ? "submitted" : decision })
      .returning();
    const [f] = await db.insert(files).values({ storageKey: `lib-${n++}`, filename: `${title}.pdf`, contentType: "application/pdf", size: 10, kind: "ops_plan" }).returning();
    await db.insert(opsPlanVersions).values({ opsPlanId: plan.id, fileId: f.id, decision });
    return { job, plan };
  }

  test("denied and pending plans never appear; vendor actors cannot search", async () => {
    const person = await fx.person();
    const agreed = await mkPlan("Lib visible parade", { startAt: agencyInstant(2020, 4, 4, 9, 0) });
    await mkPlan("Lib denied parade", { startAt: agencyInstant(2020, 5, 4, 9, 0), decision: "denied" });
    await mkPlan("Lib pending parade", { startAt: agencyInstant(2020, 6, 4, 9, 0), decision: "pending" });
    const rows = await run((tx) => searchLibrary(person, tx, { text: "Lib " }, 1));
    expect(rows.map((r) => r.jobTitle)).toEqual(["Lib visible parade"]);
    expect(rows[0].opsPlanId).toBe(agreed.plan.id);
    for (const who of [fx.coord, admin]) expect(await run((tx) => searchLibrary(who, tx, { text: "Lib " }, 1))).toHaveLength(1);
    const vendorActor: Actor = { userId: "x", role: "vendor", rankId: null, vendorId: fx.vendorId };
    await expect(run((tx) => searchLibrary(vendorActor, tx, {}, 1))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("filters by vendor, year and location; pages of 25", async () => {
    const person = await fx.person();
    const [loc] = await get().db.insert(vendorLocations).values({ vendorId: fx.otherVendorId, name: "Pier Eleven" }).returning();
    await mkPlan("Filt harbor walk", { vendorId: fx.otherVendorId, startAt: agencyInstant(2021, 3, 3, 9, 0), locationId: loc.id, location: "Pier Eleven" });
    await mkPlan("Filt main walk", { startAt: agencyInstant(2022, 3, 3, 9, 0) });
    const t = (f: Parameters<typeof searchLibrary>[2]) => run((tx) => searchLibrary(person, tx, { text: "Filt", ...f }, 1)).then((r) => r.map((x) => x.jobTitle));
    expect(await t({ vendorId: fx.otherVendorId })).toEqual(["Filt harbor walk"]);
    expect(await t({ year: 2022 })).toEqual(["Filt main walk"]);
    expect(await t({ location: "pier" })).toEqual(["Filt harbor walk"]);
    expect(await t({})).toEqual(["Filt main walk", "Filt harbor walk"]);

    for (let i = 0; i < 26; i++) await mkPlan(`Page plan ${String(i).padStart(2, "0")}`, { startAt: agencyInstant(2019, 1, 1, 9, 0) });
    const p1 = await run((tx) => searchLibrary(person, tx, { text: "Page plan" }, 1));
    const p2 = await run((tx) => searchLibrary(person, tx, { text: "Page plan" }, 2));
    expect(p1).toHaveLength(25);
    expect(p2).toHaveLength(1);
    expect(new Set([...p1, ...p2].map((r) => r.opsPlanId)).size).toBe(26);
  });

  test("search rejects a bad page and over-long text", async () => {
    const person = await fx.person();
    for (const page of [0, -1, 1.5, Number.NaN, Infinity]) await expect(run((tx) => searchLibrary(person, tx, {}, page))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => searchLibrary(person, tx, { text: "x".repeat(201) }, 1))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => searchLibrary(person, tx, { location: "x".repeat(201) }, 1))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => searchLibrary(person, tx, { text: "x".repeat(200) }, 1))).resolves.toEqual([]);
  });

  test("suggestPriorPlan: a more recent past year wins over a closer older title", async () => {
    const [v] = await get().db.insert(vendors).values({ name: "lib Ordering Vendor", defaultRateCents: 7000 }).returning();
    await mkPlan("Riverfront Holiday Lights Parade", { vendorId: v.id, startAt: agencyInstant(2023, 12, 5, 9, 0) });
    const newer = await mkPlan("Riverfront Holiday Lights Parade Night", { vendorId: v.id, startAt: agencyInstant(2024, 12, 5, 9, 0) });
    const got = await run((tx) => suggestPriorPlan(tx, { vendorId: v.id, title: "Riverfront Holiday Lights Parade", startAt: agencyInstant(2025, 12, 5, 9, 0) }));
    expect(got?.opsPlanId).toBe(newer.plan.id);
  });

  test("suggestPriorPlan returns the previous year's agreed plan for the same vendor and nothing for another vendor", async () => {
    const mine = await mkPlan("Harborfront Mardi Gras Parade", { startAt: agencyInstant(2026, 2, 17, 9, 0) });
    await mkPlan("Harborfront Mardi Gras Parade", { startAt: agencyInstant(2025, 2, 28, 9, 0) });
    await mkPlan("Harborfront Mardi Gras Parade", { startAt: agencyInstant(2024, 2, 28, 9, 0), decision: "denied" });
    await mkPlan("Totally unrelated gala", { startAt: agencyInstant(2026, 5, 1, 9, 0) });
    const got = await run((tx) => suggestPriorPlan(tx, { vendorId: fx.vendorId, title: "Harborfront Mardi Gras Parade", startAt: agencyInstant(2027, 2, 9, 9, 0) }));
    expect(got).toMatchObject({ opsPlanId: mine.plan.id, year: 2026, jobTitle: "Harborfront Mardi Gras Parade" });
    // a slightly different title still matches (similarity >= 0.6); an unrelated one does not
    expect((await run((tx) => suggestPriorPlan(tx, { vendorId: fx.vendorId, title: "Harborfront Mardi Gras Parade 2027", startAt: agencyInstant(2027, 2, 9, 9, 0) })))?.opsPlanId).toBe(mine.plan.id);
    expect(await run((tx) => suggestPriorPlan(tx, { vendorId: fx.vendorId, title: "Harbor regatta", startAt: agencyInstant(2027, 2, 9, 9, 0) }))).toBeNull();
    expect(await run((tx) => suggestPriorPlan(tx, { vendorId: fx.otherVendorId, title: "Harborfront Mardi Gras Parade", startAt: agencyInstant(2027, 2, 9, 9, 0) }))).toBeNull();
    // only past years: a 2026 request does not see its own year or later
    expect((await run((tx) => suggestPriorPlan(tx, { vendorId: fx.vendorId, title: "Harborfront Mardi Gras Parade", startAt: agencyInstant(2026, 2, 9, 9, 0) })))?.year).toBe(2025);
  });
});
