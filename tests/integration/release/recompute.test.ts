import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { auditLog, jobTypes, jobs, notifications, vendors } from "@/db/schema";
import { recomputeReleaseDates, releaseAt } from "@/domain/release/release";
import { getSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";

describe("recomputeReleaseDates", () => {
  const get = useTestDb();

  test("moves releaseAt for unreleased jobs only and sends no notifications", async () => {
    const { db } = get();
    const base = await db.transaction((tx) => getSettings(tx));
    const old = { releaseDayOfMonth: 15, releaseTime: "16:00" };
    const next = { ...base, releaseDayOfMonth: 20, releaseTime: "16:00" };

    const ids = await db.transaction(async (tx) => {
      const [v] = await tx.insert(vendors).values({ name: "Vendor" }).returning({ id: vendors.id });
      const [t] = await tx.insert(jobTypes).values({ name: "Type" }).returning({ id: jobTypes.id });
      const mk = async (
        title: string,
        start: Date,
        rel: Date,
        state: "scheduled" | "active" | "canceled" = "active",
      ) => {
        const [j] = await tx
          .insert(jobs)
          .values({
            vendorId: v.id,
            typeId: t.id,
            title,
            startAt: start,
            endAt: new Date(start.getTime() + 4 * 3600_000),
            rateCents: 5000,
            state,
            releaseAt: rel,
          })
          .returning({ id: jobs.id });
        return j.id;
      };
      const futureStart = agencyInstant(2035, 6, 10, 8, 0);
      const pastStart = agencyInstant(2020, 6, 10, 8, 0);
      return {
        unreleased: await mk("unreleased", futureStart, releaseAt(futureStart, old)),
        scheduled: await mk("scheduled", futureStart, releaseAt(futureStart, old), "scheduled"),
        canceled: await mk("canceled", futureStart, releaseAt(futureStart, old), "canceled"),
        released: await mk("released", agencyInstant(2020, 7, 10, 8, 0), releaseAt(agencyInstant(2020, 7, 10, 8, 0), old)),
        started: await mk("started", pastStart, new Date(Date.now() + 86_400_000)),
        futureStart,
        pastStart,
      };
    });

    const touched = await db.transaction((tx) => recomputeReleaseDates(tx, next, "system"));
    expect(touched).toBe(2);

    const row = async (id: string) =>
      (await db.select().from(jobs).where(eq(jobs.id, id)))[0].releaseAt;
    const moved = agencyInstant(2035, 5, 20, 16, 0);
    expect(await row(ids.unreleased)).toEqual(moved);
    expect(await row(ids.scheduled)).toEqual(moved);
    expect(await row(ids.canceled)).toEqual(releaseAt(ids.futureStart, old));
    expect(await row(ids.released)).toEqual(releaseAt(agencyInstant(2020, 7, 10, 8, 0), old));
    expect((await row(ids.started))!.getTime()).toBeGreaterThan(Date.now());

    const audits = await db.select().from(auditLog).where(eq(auditLog.action, "jobs.release_recompute"));
    expect(audits).toHaveLength(1);
    expect(await db.select().from(notifications)).toHaveLength(0);
  });

  test("an active job with a future start and a past releaseAt is unchanged and not counted", async () => {
    const { db } = get();
    const next = { ...(await db.transaction((tx) => getSettings(tx))), releaseDayOfMonth: 20, releaseTime: "16:00" };
    const past = new Date(Date.now() - 86_400_000);
    const id = await db.transaction(async (tx) => {
      const [v] = await tx.insert(vendors).values({ name: "Vendor Past" }).returning({ id: vendors.id });
      const [t] = await tx.insert(jobTypes).values({ name: "Type Past" }).returning({ id: jobTypes.id });
      const start = agencyInstant(2036, 6, 10, 8, 0);
      const [j] = await tx
        .insert(jobs)
        .values({
          vendorId: v.id,
          typeId: t.id,
          title: "released early",
          startAt: start,
          endAt: new Date(start.getTime() + 4 * 3600_000),
          rateCents: 5000,
          state: "active",
          releaseAt: past,
        })
        .returning({ id: jobs.id });
      return j.id;
    });
    const touched = await db.transaction((tx) => recomputeReleaseDates(tx, next, "system"));
    expect(touched).toBe(0);
    const [row] = await db.select().from(jobs).where(eq(jobs.id, id));
    expect(row.releaseAt).toEqual(past);
  });
});
