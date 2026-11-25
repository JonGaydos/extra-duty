import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "./helpers";
import { accounts, assignments, jobPositions, jobTypes, jobs, positionTypes, users, vendors, notifications } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError } from "@/domain/errors";
import { listAudit } from "@/domain/audit/audit";
import { inactivityLockTick, isSuspended, liftExpiredSuspensions, suspendUser } from "@/domain/users/suspension";

const DAY = 86_400_000;

describe("suspension and inactivity", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let coordinator: Actor;
  let personnel: Actor;
  let target: string;
  let pastId: string;
  let futureId: string;
  let backupId: string;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coordinator = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    personnel = (await makeUser(db, "personnel", "pers@example.test")).actor;
    target = (await makeUser(db, "personnel", "target@example.test")).row.id;
    const [v] = await db.insert(vendors).values({ name: "V" }).returning();
    const [jt] = await db.insert(jobTypes).values({ name: "T" }).returning();
    const [pt] = await db.insert(positionTypes).values({ name: "P" }).returning();
    const mk = async (startAt: Date) => {
      const [j] = await db
        .insert(jobs)
        .values({ vendorId: v.id, typeId: jt.id, title: "J", startAt, endAt: new Date(startAt.getTime() + 3_600_000), rateCents: 4000 })
        .returning();
      const [p] = await db.insert(jobPositions).values({ jobId: j.id, positionTypeId: pt.id }).returning();
      return { j, p };
    };
    const past = await mk(new Date(Date.now() - 5 * DAY));
    const fut = await mk(new Date(Date.now() + 5 * DAY));
    const bak = await mk(new Date(Date.now() + 6 * DAY));
    const ins = async (x: { j: { id: string }; p: { id: string } }, status: "signed_up" | "backup") =>
      (await db.insert(assignments).values({ jobId: x.j.id, jobPositionId: x.p.id, userId: target, status }).returning())[0].id;
    pastId = await ins(past, "signed_up");
    futureId = await ins(fut, "signed_up");
    backupId = await ins(bak, "backup");
    const pend = await mk(new Date(Date.now() + 7 * DAY));
    await db.insert(assignments).values({ jobId: pend.j.id, jobPositionId: pend.p.id, userId: target, status: "pending_short" });
  });

  test("personnel cannot suspend", async () => {
    const { db } = get();
    await expect(
      db.transaction((tx) => suspendUser(personnel, tx, target, { reason: "x", until: null, removeFutureAssignments: false })),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("suspending with removeFutureAssignments removes future signed_up and backup only", async () => {
    const { db } = get();
    const until = new Date(Date.now() + 10 * DAY);
    await db.transaction((tx) => suspendUser(coordinator, tx, target, { reason: "Policy review", until, removeFutureAssignments: true }));
    const status = async (id: string) => (await db.select().from(assignments).where(eq(assignments.id, id)))[0].status;
    expect(await status(futureId)).toBe("removed");
    expect(await status(backupId)).toBe("removed");
    expect(await status(pastId)).toBe("signed_up");
    const left = await db.select().from(assignments).where(and(eq(assignments.userId, target), eq(assignments.status, "pending_short")));
    expect(left).toHaveLength(0);
    const sent = await db.select().from(notifications).where(and(eq(notifications.userId, target), eq(notifications.type, "assignment.removed")));
    expect(sent).toHaveLength(3);
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: futureId }, 1));
    expect(audit[0]).toMatchObject({ action: "assignment.suspension_remove", reason: "Suspended: Policy review" });
    const [u] = await db.select().from(users).where(eq(users.id, target));
    expect(isSuspended(u, new Date())).toBe(true);
    expect(isSuspended(u, new Date(until.getTime() + 1))).toBe(false);
  });

  test("isSuspended is false when never suspended and true when open ended", () => {
    expect(isSuspended({ suspendedUntil: null, suspensionReason: null }, new Date())).toBe(false);
    expect(isSuspended({ suspendedUntil: null, suspensionReason: "r" }, new Date())).toBe(true);
  });

  test("liftExpiredSuspensions clears expired suspensions and audits as system", async () => {
    const { db } = get();
    const future = new Date(Date.now() + 10 * DAY);
    const n = await db.transaction((tx) => liftExpiredSuspensions(tx, new Date(future.getTime() + DAY)));
    expect(n).toBe(1);
    const [u] = await db.select().from(users).where(eq(users.id, target));
    expect(u).toMatchObject({ suspendedUntil: null, suspensionReason: null });
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: target }, 1));
    expect(audit[0]).toMatchObject({ action: "user.suspension_lift", actorUserId: null });
    expect(await db.transaction((tx) => liftExpiredSuspensions(tx, new Date(future.getTime() + DAY)))).toBe(0);
  });

  test("inactivityLockTick locks at 91 days, not at 89, and not after a recent password set", async () => {
    const { db } = get();
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    const old = await makeUser(db, "personnel", "old@example.test", { lastSignInAt: at(91), createdAt: at(200) });
    const recent = await makeUser(db, "personnel", "recent@example.test", { lastSignInAt: at(89), createdAt: at(200) });
    const reset = await makeUser(db, "personnel", "reset@example.test", { lastSignInAt: at(91), createdAt: at(200) });
    await db.insert(accounts).values({
      accountId: reset.row.id,
      providerId: "credential",
      userId: reset.row.id,
      password: "x",
      updatedAt: at(1),
    });
    await db.transaction((tx) => inactivityLockTick(tx, now));
    const lock = async (id: string) => (await db.select().from(users).where(eq(users.id, id)))[0];
    expect(await lock(old.row.id)).toMatchObject({ lockReason: "inactivity" });
    expect((await lock(old.row.id)).lockedAt).not.toBeNull();
    expect((await lock(recent.row.id)).lockedAt).toBeNull();
    expect((await lock(reset.row.id)).lockedAt).toBeNull();
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: old.row.id }, 1));
    expect(audit[0]).toMatchObject({ action: "user.lock", actorUserId: null });
  });
});
