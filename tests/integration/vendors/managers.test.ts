import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { byText } from "@/lib/sort";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { call, sessionToken, bearer } from "../api/helpers";
import { auditLog, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { loadActiveActor } from "@/domain/auth/sign-in-policy";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { managedVendors, setManagedVendors, vendorManagerIds } from "@/domain/vendors/managers";
import { PUT as putManaged } from "@/app/api/v1/users/[id]/managed-vendors/route";

describe("vendors a deputy manages", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let sergeant: Actor;
  let deputy: Actor;
  let thirdVendor: string;

  beforeAll(async () => {
    f = await setupFixture(get().db, "mgr");
    sergeant = await f.person();
    deputy = await f.person();
    [{ id: thirdVendor }] = await get().db.insert(vendors).values({ name: "mgr Third Vendor" }).returning({ id: vendors.id });
  });

  const load = (who: Actor) => f.run((tx) => loadActiveActor(tx, who.userId));

  test("a coordinator sets them, the change is audited, and the person's actor carries them", async () => {
    await f.run((tx) => setManagedVendors(f.coord, tx, sergeant.userId, [f.vendorId, f.otherVendorId]));
    expect([...((await load(sergeant))?.managedVendorIds ?? [])].toSorted(byText)).toEqual([f.vendorId, f.otherVendorId].toSorted(byText));
    await f.run((tx) => setManagedVendors(f.coord, tx, sergeant.userId, [f.vendorId, thirdVendor]));
    expect([...((await load(sergeant))?.managedVendorIds ?? [])].toSorted(byText)).toEqual([f.vendorId, thirdVendor].toSorted(byText));
    const audits = await get()
      .db.select()
      .from(auditLog)
      .where(and(eq(auditLog.action, "user.managed_vendors"), eq(auditLog.entityId, sergeant.userId)));
    expect(audits).toHaveLength(2);
    expect(audits.every((a) => a.actorUserId === f.coord.userId)).toBe(true);
    const last = audits.find((a) => (a.after as { vendorIds: string[] }).vendorIds.includes(thirdVendor))!;
    expect((last.before as { vendorIds: string[] }).vendorIds.toSorted(byText)).toEqual([f.vendorId, f.otherVendorId].toSorted(byText));
    expect(await f.run((tx) => vendorManagerIds(tx, f.vendorId))).toEqual([sergeant.userId]);
    const loaded = (await load(sergeant))!;
    expect((await f.run((tx) => managedVendors(loaded, tx))).map((v) => v.name).toSorted(byText)).toEqual(["mgr Third Vendor", "mgr Vendor"]);
  });

  test("an unchanged list writes no audit row; an empty list clears it", async () => {
    const before = await get().db.select().from(auditLog).where(eq(auditLog.action, "user.managed_vendors"));
    await f.run((tx) => setManagedVendors(f.coord, tx, sergeant.userId, [thirdVendor, f.vendorId]));
    expect(await get().db.select().from(auditLog).where(eq(auditLog.action, "user.managed_vendors"))).toHaveLength(before.length);
    await f.run((tx) => setManagedVendors(f.coord, tx, sergeant.userId, []));
    expect((await load(sergeant))?.managedVendorIds ?? []).toEqual([]);
    await f.run((tx) => setManagedVendors(f.coord, tx, sergeant.userId, [f.vendorId]));
  });

  test("deputies cannot set them, only a deputy can manage vendors, and the vendors must exist", async () => {
    await expect(f.run((tx) => setManagedVendors(deputy, tx, deputy.userId, [f.vendorId]))).rejects.toBeInstanceOf(ForbiddenError);
    const manager = (await load(sergeant))!;
    await expect(f.run((tx) => setManagedVendors(manager, tx, deputy.userId, [f.vendorId]))).rejects.toBeInstanceOf(ForbiddenError);
    const coord2 = (await makeUser(get().db, "coordinator", "mgr-coord2@example.test")).actor;
    await expect(f.run((tx) => setManagedVendors(f.coord, tx, coord2.userId, [f.vendorId]))).rejects.toBeInstanceOf(ValidationError);
    await expect(f.run((tx) => setManagedVendors(f.coord, tx, deputy.userId, ["00000000-0000-7000-8000-000000000000"]))).rejects.toBeInstanceOf(ValidationError);
  });

  test("the API sets them for staff and refuses a deputy", async () => {
    const coordToken = await sessionToken(get().db, f.coord.userId);
    const put = (token: string, vendorIds: string[]) =>
      call(putManaged, `/api/v1/users/${deputy.userId}/managed-vendors`, {
        method: "PUT",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ vendorIds }),
        params: { id: deputy.userId },
      });
    const res = await put(coordToken, [f.otherVendorId]);
    expect(res.status).toBe(200);
    expect((await load(deputy))?.managedVendorIds).toEqual([f.otherVendorId]);
    const deputyToken = await sessionToken(get().db, sergeant.userId);
    expect((await put(deputyToken, [f.vendorId])).status).toBe(403);
    await f.run((tx) => setManagedVendors(f.coord, tx, deputy.userId, []));
  });
});
