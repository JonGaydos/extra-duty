import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { auditLog, notifications, users } from "@/db/schema";
import { setupEmail } from "@/db/setup-email";
import { getSettings } from "@/domain/settings/settings";
import { decryptSecret } from "@/lib/crypto/secrets";

describe("first-run email setup (ROLE=setup-email)", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let adminId: string;
  beforeAll(async () => {
    const [a] = await get().db.insert(users).values({ name: "Administrator", email: "admin@county.example", role: "admin" }).returning();
    adminId = a.id;
  });

  test("saves the SMTP server as the first admin, with the password encrypted and the change audited", async () => {
    const { db } = get();
    await setupEmail(db, {
      SEED_ADMIN_EMAIL: "Admin@County.example",
      SETUP_EMAIL_FROM: "Extra Duty <noreply@county.example>",
      SETUP_SMTP_HOST: "smtp.county.example",
      SETUP_SMTP_PORT: "587",
      SETUP_SMTP_USER: "extraduty",
      SETUP_SMTP_PASSWORD: "placeholder-password",
    });
    const s = await db.transaction((tx) => getSettings(tx));
    expect(s.email).toMatchObject({ provider: "smtp", from: "Extra Duty <noreply@county.example>", smtp: { host: "smtp.county.example", port: 587, secure: false, user: "extraduty" } });
    expect(s.email.smtp.passwordEnc).not.toContain("placeholder-password");
    expect(decryptSecret(s.email.smtp.passwordEnc)).toBe("placeholder-password");
    const audit = await db.select().from(auditLog).where(and(eq(auditLog.action, "settings.update"), eq(auditLog.actorUserId, adminId)));
    expect(audit.length).toBeGreaterThan(0);
    expect(JSON.stringify(audit)).not.toContain("placeholder-password");
  });

  test("a second run is refused while an email server is saved, and nothing changes", async () => {
    const { db } = get();
    const before = (await db.transaction((tx) => getSettings(tx))).email;
    await expect(
      setupEmail(db, { SEED_ADMIN_EMAIL: "admin@county.example", SETUP_EMAIL_FROM: "x@relay.example", SETUP_SMTP_HOST: "relay.example" }),
    ).rejects.toThrow(/already saved.*--replace/);
    expect((await db.transaction((tx) => getSettings(tx))).email).toEqual(before);
  });

  test("with --replace it saves, audits the replacement and alerts every admin in the app and by email", async () => {
    const { db } = get();
    const [second] = await db.insert(users).values({ name: "Second Admin", email: "admin2@county.example", role: "admin" }).returning();
    await setupEmail(db, { SEED_ADMIN_EMAIL: "admin@county.example", SETUP_EMAIL_FROM: "x@county.example", SETUP_SMTP_HOST: "smtp2.county.example" }, { replace: true });
    expect((await db.transaction((tx) => getSettings(tx))).email.smtp.host).toBe("smtp2.county.example");
    const [audit] = await db.select().from(auditLog).where(eq(auditLog.action, "settings.email_replaced"));
    expect(audit).toMatchObject({ actorUserId: adminId, before: { host: "smtp.county.example" }, after: { host: "smtp2.county.example" } });
    const alerts = await db.select().from(notifications).where(eq(notifications.type, "settings.email_replaced"));
    expect(alerts.map((a) => a.userId).sort()).toEqual([adminId, second.id].sort());
    const queued = await db.execute<{ n: number }>(sql`select count(*)::int as n from pgboss.job where name = 'notify.email'`);
    expect(queued.rows[0].n).toBe(2);
  });

  test("refuses without the first admin or the server details", async () => {
    const { db } = get();
    await expect(setupEmail(db, { SEED_ADMIN_EMAIL: "nobody@county.example", SETUP_EMAIL_FROM: "a@b.example", SETUP_SMTP_HOST: "h" })).rejects.toThrow(/admin/);
    await expect(setupEmail(db, { SEED_ADMIN_EMAIL: "admin@county.example", SETUP_EMAIL_FROM: "a@b.example" })).rejects.toThrow(/SETUP_SMTP_HOST/);
  });
});
