import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "./helpers";
import { invites, qualifications, userQualifications, users } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { listAudit } from "@/domain/audit/audit";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { useEmailQueue } from "../../setup/email-queue";
import { createUser, deactivateUser, updateUser } from "@/domain/users/users";
import { byText } from "@/lib/sort";

describe("users", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let coordinator: Actor;
  let personnel: Actor;
  let admin: Actor;
  let qualId: string;

  beforeAll(async () => {
    const { db } = get();
    setEmailSender(mail);
    await seed(db);
    coordinator = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    personnel = (await makeUser(db, "personnel", "pers@example.test")).actor;
    admin = (await makeUser(db, "admin", "admin@example.test")).actor;
    [{ id: qualId }] = await db.insert(qualifications).values({ name: "Taser" }).returning();
  });

  const input = { email: "New.Person@Example.test", name: "New Person", phone: "850-555-0123", role: "personnel" as const, rankId: null, badgeNumber: "12" };

  test("personnel and vendors cannot create users", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => createUser(personnel, tx, input))).rejects.toBeInstanceOf(ForbiddenError);
    const vendor: Actor = { userId: personnel.userId, role: "vendor", rankId: null, vendorId: "v" };
    await expect(db.transaction((tx) => createUser(vendor, tx, input))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("createUser inserts, grants qualifications, invites and audits", async () => {
    const { db } = get();
    mail.clear();
    const u = await db.transaction((tx) => createUser(coordinator, tx, { ...input, qualificationIds: [qualId] }));
    expect(u.email).toBe("new.person@example.test");
    expect(mail.sent).toHaveLength(0);
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(await db.select().from(invites).where(eq(invites.userId, u.id))).toHaveLength(1);
    const q = await db.select().from(userQualifications).where(eq(userQualifications.userId, u.id));
    expect(q).toMatchObject([{ qualificationId: qualId, grantedBy: coordinator.userId }]);
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: u.id }, 1));
    expect(audit.map((a) => a.action).sort(byText)).toEqual(["user.create", "user.invite", "user.qualification_grant"]);
  });

  test("duplicate email is refused", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => createUser(coordinator, tx, input))).rejects.toBeInstanceOf(ValidationError);
  });

  test("a coordinator cannot create or promote an admin", async () => {
    const { db } = get();
    await expect(
      db.transaction((tx) => createUser(coordinator, tx, { ...input, email: "a2@example.test", role: "admin" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(
      db.transaction((tx) => updateUser(coordinator, tx, personnel.userId, { role: "admin" })),
    ).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => deactivateUser(coordinator, tx, admin.userId, { reason: "Left the agency", lastDay: "2026-01-02" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("updateUser changes fields and audits before and after", async () => {
    const { db } = get();
    const u = await db.transaction((tx) => updateUser(coordinator, tx, personnel.userId, { phone: "(850) 555-0199", badgeNumber: "7" }));
    expect(u).toMatchObject({ phone: "850-555-0199", badgeNumber: "7" });
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: personnel.userId }, 1));
    expect(audit.some((a) => a.action === "user.update")).toBe(true);
  });

  test("deactivateUser keeps the row and history and audits", async () => {
    const { db } = get();
    const { row } = await makeUser(db, "personnel", "gone@example.test");
    await db.transaction((tx) => deactivateUser(coordinator, tx, row.id, { reason: "Left the agency", lastDay: "2026-01-02" }));
    const [after] = await db.select().from(users).where(eq(users.id, row.id));
    expect(after).toMatchObject({ active: false, email: "gone@example.test" });
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: row.id }, 1));
    expect(audit.map((a) => a.action)).toContain("user.deactivate");
  });

  test("personnel cannot deactivate; nobody can deactivate themselves", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => deactivateUser(personnel, tx, coordinator.userId, { reason: "Left the agency", lastDay: "2026-01-02" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => deactivateUser(coordinator, tx, coordinator.userId, { reason: "Left the agency", lastDay: "2026-01-02" }))).rejects.toBeInstanceOf(ValidationError);
  });

  test("the last active admin cannot demote themselves; with another active admin they can", async () => {
    const { db } = get();
    const solo = (await makeUser(db, "admin", "solo-admin@example.test")).actor;
    // Every other admin is inactive: solo is the last one who can reach the admin-only settings.
    await db.update(users).set({ active: false }).where(eq(users.role, "admin"));
    await db.update(users).set({ active: true }).where(eq(users.id, solo.userId));
    const err = await db.transaction((tx) => updateUser(solo, tx, solo.userId, { role: "coordinator" })).catch((e) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect(err.message).toBe("At least one active admin is needed. Make someone else an admin first.");
    expect((await db.select().from(users).where(eq(users.id, solo.userId)))[0].role).toBe("admin");
    // A name change is still fine.
    await db.transaction((tx) => updateUser(solo, tx, solo.userId, { name: "Solo Admin" }));

    const next = (await makeUser(db, "coordinator", "next-admin@example.test")).actor;
    await db.transaction((tx) => updateUser(solo, tx, next.userId, { role: "admin" }));
    const after = await db.transaction((tx) => updateUser(solo, tx, solo.userId, { role: "coordinator" }));
    expect(after.role).toBe("coordinator");
  });
});
