import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, isNull, sql } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { vendorHolds, vendors } from "@/db/schema";
import { migrationsFolder } from "@/db/migrate";
import { ValidationError } from "@/domain/errors";
import { isJobLocked } from "@/domain/vendor-portal/holds";
import { placePaymentHold, resolvePaymentHold } from "@/domain/vendors/vendors";

/** Two coordinators (or one double click) placing a hold at once must leave exactly one open hold. */
describe("payment hold races", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;

  beforeAll(async () => {
    f = await setupFixture(get().db, "hold-race");
  });

  const openHolds = async (vendorId: string) => get().db.select().from(vendorHolds).where(and(eq(vendorHolds.vendorId, vendorId), isNull(vendorHolds.resolvedAt)));

  test("two holds placed at once: one succeeds, the other is refused, and lifting unlocks the details", async () => {
    const { db } = get();
    const other = (await makeUser(db, "coordinator", "hold-race-2@example.test")).actor;
    const [v] = await db.insert(vendors).values({ name: "Race Vendor", defaultRateCents: 7000 }).returning();
    const { job } = await f.mkJob({ vendor: v.id });
    const results = await Promise.allSettled([
      db.transaction((tx) => placePaymentHold(f.coord, tx, v.id, "Unpaid invoices")),
      db.transaction((tx) => placePaymentHold(other, tx, v.id, "Unpaid invoices")),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const refused = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(refused.reason).toBeInstanceOf(ValidationError);
    expect(refused.reason.message).toBe("This vendor already has a payment hold.");
    expect(await openHolds(v.id)).toHaveLength(1);
    expect(await db.transaction((tx) => isJobLocked(tx, job.id))).toBe(true);

    await db.transaction((tx) => resolvePaymentHold(f.coord, tx, v.id, { outcome: "handled" }));
    expect(await openHolds(v.id)).toHaveLength(0);
    expect(await db.transaction((tx) => isJobLocked(tx, job.id))).toBe(false);
  });

  test("the database allows one open hold per vendor; resolved holds do not count", async () => {
    const { db } = get();
    const [v] = await db.insert(vendors).values({ name: "Index Vendor", defaultRateCents: 7000 }).returning();
    await db.insert(vendorHolds).values({ vendorId: v.id, reason: "Old", resolvedAt: new Date() });
    await db.insert(vendorHolds).values({ vendorId: v.id, reason: "First" });
    const err = await db.insert(vendorHolds).values({ vendorId: v.id, reason: "Second" }).catch((e) => e);
    expect(err?.cause?.code ?? err?.code).toBe("23505");
  });

  test("the migration closes duplicate open holds (keeping the oldest) and open holds of a vendor not on hold", async () => {
    const { db } = get();
    const name = (await readdir(migrationsFolder)).find((n) => /^\d{4}_.*\.sql$/.test(n) && n.includes("one_open_hold"));
    expect(name).toBeTruthy();
    const statements = (await readFile(join(migrationsFolder, name!), "utf8")).split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    // Rebuild the state the race left behind, then run the migration's statements again.
    await db.execute(sql`drop index vendor_holds_one_open_idx`);
    const [dup] = await db.insert(vendors).values({ name: "Dup Vendor", defaultRateCents: 7000, paymentHold: true, paymentHoldReason: "Late" }).returning();
    const [stuck] = await db.insert(vendors).values({ name: "Stuck Vendor", defaultRateCents: 7000, paymentHold: false }).returning();
    const [first] = await db.insert(vendorHolds).values({ vendorId: dup.id, reason: "Late", placedAt: new Date("2035-01-01T10:00:00Z") }).returning();
    await db.insert(vendorHolds).values({ vendorId: dup.id, reason: "Late", placedAt: new Date("2035-01-01T10:00:01Z") });
    await db.insert(vendorHolds).values({ vendorId: stuck.id, reason: "Late", placedAt: new Date("2035-01-01T10:00:00Z") });
    for (const s of statements) await db.execute(sql.raw(s));
    expect((await openHolds(dup.id)).map((h) => h.id)).toEqual([first.id]);
    expect(await openHolds(stuck.id)).toHaveLength(0);
    const [closed] = await db.select().from(vendorHolds).where(eq(vendorHolds.vendorId, stuck.id));
    expect(closed).toMatchObject({ outcome: "handled" });
    expect(closed.note).toMatch(/duplicate|lifted/i);
  });
});
