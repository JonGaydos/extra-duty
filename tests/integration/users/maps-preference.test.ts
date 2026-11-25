import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { auditLog } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ValidationError } from "@/domain/errors";
import { getShellProfile, setMapsPreference } from "@/domain/users/profile";
import { makeUser } from "./helpers";

describe("preferred maps app", () => {
  const get = useTestDb();
  let deputy: Actor;
  let other: Actor;

  beforeAll(async () => {
    deputy = (await makeUser(get().db, "personnel", "maps-deputy@example.test")).actor;
    other = (await makeUser(get().db, "personnel", "maps-other@example.test")).actor;
  });

  test("defaults to ask (null)", async () => {
    const p = await get().db.transaction((tx) => getShellProfile(deputy, tx));
    expect(p.mapsApp).toBeNull();
  });

  test("a person saves their own choice, audited, and can go back to ask", async () => {
    await get().db.transaction((tx) => setMapsPreference(deputy, tx, "apple"));
    expect((await get().db.transaction((tx) => getShellProfile(deputy, tx))).mapsApp).toBe("apple");
    expect((await get().db.transaction((tx) => getShellProfile(other, tx))).mapsApp).toBeNull();
    const audits = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "user.maps_app_set"), eq(auditLog.entityId, deputy.userId)));
    expect(audits).toHaveLength(1);
    expect(audits[0].after).toEqual({ preferredMapsApp: "apple" });
    await get().db.transaction((tx) => setMapsPreference(deputy, tx, null));
    expect((await get().db.transaction((tx) => getShellProfile(deputy, tx))).mapsApp).toBeNull();
  });

  test("anything but google, apple, osm or null is refused", async () => {
    await expect(get().db.transaction((tx) => setMapsPreference(deputy, tx, "waze" as never))).rejects.toBeInstanceOf(ValidationError);
  });
});
