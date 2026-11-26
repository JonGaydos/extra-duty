import { beforeAll, describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { positionTypes, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError } from "@/domain/errors";
import { listAudit } from "@/domain/audit/audit";
import { getSettings, updateSettings } from "@/domain/settings/settings";
import { DEFAULT_SETTINGS } from "@/domain/settings/defaults";
import { decryptSecret } from "@/lib/crypto/secrets";

describe("settings", () => {
  const get = useTestDb();
  let coordinator: Actor;
  let admin: Actor;
  let personnel: Actor;
  let deputyTypeId: string;

  beforeAll(async () => {
    const { db } = get();
    const rows = await db
      .insert(users)
      .values([
        { name: "Coord", email: "c@example.test", role: "coordinator" },
        { name: "Admin", email: "a@example.test", role: "admin" },
        { name: "Pers", email: "p@example.test", role: "personnel" },
      ])
      .returning();
    const mk = (i: number, role: Actor["role"]): Actor => ({ userId: rows[i].id, role, rankId: null, vendorId: null });
    coordinator = mk(0, "coordinator");
    admin = mk(1, "admin");
    personnel = mk(2, "personnel");
    const [pt] = await db.insert(positionTypes).values({ name: "Deputy Sheriff" }).returning();
    deputyTypeId = pt.id;
  });

  test("fresh database returns the defaults, with the Deputy Sheriff position type", async () => {
    const s = await get().db.transaction((tx) => getSettings(tx));
    expect(s).toEqual({ ...DEFAULT_SETTINGS, defaultPositionTypeId: deputyTypeId });
    expect(s.releaseDayOfMonth).toBe(15);
    expect(s.minimumBillableMinutes).toBe(240);
    expect(s.security.twoFactorRequired).toBe(true);
    expect(s.responseDays).toEqual({ vendor: 30, deputy: 30, coordinator: 7 });
  });

  test("personnel cannot update anything", async () => {
    await expect(
      get().db.transaction((tx) => updateSettings(personnel, tx, { minimumBillableMinutes: 120 })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("an unknown key is refused, and a coordinator cannot change admin-only keys", async () => {
    const save = (a: Actor, patch: Record<string, unknown>) => get().db.transaction((tx) => updateSettings(a, tx, patch as never));
    await expect(save(admin, { nope: 1, alsoNope: 2, minimumBillableMinutes: undefined })).rejects.toThrow("Unknown setting: nope, alsoNope.");
    await expect(save(coordinator, { security: { twoFactorRequired: false } })).rejects.toThrow(new ForbiddenError("Only admins can change: security."));
  });

  test("coordinator updates a normal key; it persists with one audit row", async () => {
    const { db } = get();
    const out = await db.transaction((tx) => updateSettings(coordinator, tx, { minimumBillableMinutes: 180 }));
    expect(out.minimumBillableMinutes).toBe(180);
    const again = await db.transaction((tx) => getSettings(tx));
    expect(again.minimumBillableMinutes).toBe(180);
    expect(again.releaseDayOfMonth).toBe(15);
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityType: "settings" }, 1));
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("settings.update");
    expect((audit[0].before as { minimumBillableMinutes: number }).minimumBillableMinutes).toBe(240);
    expect((audit[0].after as { minimumBillableMinutes: number }).minimumBillableMinutes).toBe(180);
  });

  test("coordinator patch with an admin-only key is rejected whole", async () => {
    const { db } = get();
    await expect(
      db.transaction((tx) =>
        updateSettings(coordinator, tx, { hourRoundingMinutes: 30, email: { provider: "postmark" } }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      db.transaction((tx) => updateSettings(coordinator, tx, { security: { passwordMinLength: 8 } })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    const s = await db.transaction((tx) => getSettings(tx));
    expect(s.hourRoundingMinutes).toBe(15);
  });

  test("releaseDayOfMonth 0 and 32 are rejected", async () => {
    const { db } = get();
    for (const v of [0, 32]) {
      await expect(db.transaction((tx) => updateSettings(coordinator, tx, { releaseDayOfMonth: v }))).rejects.toThrow();
    }
    expect((await db.transaction((tx) => getSettings(tx))).releaseDayOfMonth).toBe(15);
  });

  test("changing signupWarningText increments signupWarningVersion", async () => {
    const { db } = get();
    const a = await db.transaction((tx) => updateSettings(coordinator, tx, { signupWarningText: "Be advised." }));
    expect(a.signupWarningVersion).toBe(2);
    const same = await db.transaction((tx) => updateSettings(coordinator, tx, { signupWarningText: "Be advised." }));
    expect(same.signupWarningVersion).toBe(2);
    const b = await db.transaction((tx) => updateSettings(coordinator, tx, { signupWarningText: "Changed." }));
    expect(b.signupWarningVersion).toBe(3);
  });

  test("admin stores email secrets encrypted only; audit masks them", async () => {
    const { db } = get();
    await db.transaction((tx) =>
      updateSettings(admin, tx, { email: { provider: "smtp", smtp: { host: "mail.test", password: "s3cret" }, apiKey: "key-1" } }),
    );
    const s = await db.transaction((tx) => getSettings(tx));
    expect(s.email.smtp.host).toBe("mail.test");
    expect(s.email.smtp.port).toBe(587);
    expect(s.email.smtp.passwordEnc).not.toContain("s3cret");
    expect(decryptSecret(s.email.smtp.passwordEnc)).toBe("s3cret");
    expect(decryptSecret(s.email.apiKeyEnc)).toBe("key-1");
    expect(JSON.stringify(s)).not.toContain("key-1");
    const audit = await db.transaction((tx) => listAudit(admin, tx, { entityType: "settings" }, 1));
    const json = JSON.stringify(audit);
    expect(json).not.toContain("s3cret");
    expect(json).not.toContain(s.email.smtp.passwordEnc);
  });
});
