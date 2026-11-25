import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "./helpers";
import { auditLog } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ValidationError } from "@/domain/errors";
import { getShellProfile, setThemePreference } from "@/domain/users/profile";

describe("theme preference", () => {
  const get = useTestDb();
  let deputy: Actor;
  let other: Actor;

  beforeAll(async () => {
    const { db } = get();
    deputy = (await makeUser(db, "personnel", "theme@example.test", { name: "Sam Whitley" })).actor;
    other = (await makeUser(db, "personnel", "other@example.test")).actor;
  });

  test("a new account follows the device (no preference)", async () => {
    const { db } = get();
    const profile = await db.transaction((tx) => getShellProfile(deputy, tx));
    expect(profile).toEqual({ name: "Sam Whitley", initials: "SW", themePreference: null, mapsApp: null });
  });

  test("the override is saved on the signed-in user only, and audited", async () => {
    const { db } = get();
    await db.transaction((tx) => setThemePreference(deputy, tx, "night"));
    expect((await db.transaction((tx) => getShellProfile(deputy, tx))).themePreference).toBe("night");
    expect((await db.transaction((tx) => getShellProfile(other, tx))).themePreference).toBeNull();
    const rows = await db
      .select()
      .from(auditLog)
      .where(and(eq(auditLog.entityId, deputy.userId), eq(auditLog.action, "user.theme_set")));
    expect(rows).toHaveLength(1);
    expect(rows[0].before).toEqual({ themePreference: null });
    expect(rows[0].after).toEqual({ themePreference: "night" });
  });

  test("null clears the override back to the device setting", async () => {
    const { db } = get();
    await db.transaction((tx) => setThemePreference(deputy, tx, null));
    expect((await db.transaction((tx) => getShellProfile(deputy, tx))).themePreference).toBeNull();
  });

  test("an unknown theme is rejected", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => setThemePreference(deputy, tx, "sepia" as never))).rejects.toBeInstanceOf(
      ValidationError,
    );
  });
});
