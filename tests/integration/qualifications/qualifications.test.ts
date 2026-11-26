import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { auditLog, qualifications, userQualifications } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { createUser } from "@/domain/users/users";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { useEmailQueue } from "../../setup/email-queue";
import {
  createQualification,
  decideQualificationRequest,
  grantQualification,
  listMyQualificationRequests,
  listMyQualifications,
  listPendingQualificationRequests,
  listUserQualifications,
  qualificationHolderCount,
  requestQualification,
  revokeQualification,
  setQualificationActive,
} from "@/domain/jobs/qualifications";
import { byText } from "@/lib/sort";

describe("qualifications", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let coord: Actor;
  let deputy: Actor;
  let other: Actor;
  let vendor: Actor;
  let k9: string;
  let motors: string;
  let src: string;
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) =>
    get().db.transaction(fn);

  beforeAll(async () => {
    const { db } = get();
    setEmailSender(createMemorySender());
    await seed(db);
    coord = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    deputy = (await makeUser(db, "personnel", "dep@example.test")).actor;
    other = (await makeUser(db, "personnel", "other@example.test")).actor;
    vendor = (await makeUser(db, "vendor", "vend@example.test")).actor;
    const q = await db.select().from(qualifications);
    k9 = q.find((x) => x.name === "K9")!.id;
    motors = q.find((x) => x.name === "Motors")!.id;
    src = q.find((x) => x.name === "School Resource Deputy")!.id;
  });

  test("request, pending list, approval grants and writes both audit rows", async () => {
    const req = await run((tx) => requestQualification(deputy, tx, k9, "Completed handler course"));
    expect(req).toMatchObject({ userId: deputy.userId, status: "pending" });
    await expect(run((tx) => requestQualification(deputy, tx, k9))).rejects.toBeInstanceOf(ValidationError);
    expect((await run((tx) => listPendingQualificationRequests(coord, tx))).map((r) => r.id)).toContain(req.id);
    await expect(run((tx) => listPendingQualificationRequests(deputy, tx))).rejects.toBeInstanceOf(ForbiddenError);

    const approved = await run((tx) => decideQualificationRequest(coord, tx, req.id, { approve: true }));
    expect(approved).toMatchObject({ status: "approved", userId: deputy.userId, decidedBy: coord.userId });
    expect((await run((tx) => listMyQualifications(deputy, tx))).map((m) => m.qualificationId)).toEqual([k9]);
    await expect(run((tx) => decideQualificationRequest(coord, tx, req.id, { approve: true }))).rejects.toBeInstanceOf(
      RuleViolation,
    );

    const reqAudit = await get().db.select().from(auditLog).where(eq(auditLog.entityId, req.id));
    expect(reqAudit.map((a) => a.action)).toEqual(["qualification_request.create", "qualification_request.approve"]);
    const userAudit = await get().db.select().from(auditLog).where(eq(auditLog.entityId, deputy.userId));
    expect(userAudit.map((a) => a.action)).toContain("user.qualification_grant");
    expect(userAudit.find((a) => a.action === "user.qualification_grant")?.actorUserId).toBe(coord.userId);
  });

  test("a request for an already-held flag is refused", async () => {
    await expect(run((tx) => requestQualification(deputy, tx, k9))).rejects.toBeInstanceOf(ValidationError);
  });

  test("denial works with or without a reason and grants nothing", async () => {
    const r1 = await run((tx) => requestQualification(deputy, tx, motors));
    const d1 = await run((tx) => decideQualificationRequest(coord, tx, r1.id, { approve: false }));
    expect(d1).toMatchObject({ status: "denied", reason: null });
    // A fresh request after a decision is allowed.
    const r2 = await run((tx) => requestQualification(deputy, tx, motors));
    expect(r2.id).not.toBe(r1.id);
    const d2 = await run((tx) => decideQualificationRequest(coord, tx, r2.id, { approve: false, reason: "Needs the course first" }));
    expect(d2).toMatchObject({ status: "denied", reason: "Needs the course first" });
    expect((await run((tx) => listMyQualifications(deputy, tx))).map((m) => m.qualificationId)).toEqual([k9]);
    const audits = await get().db.select().from(auditLog).where(eq(auditLog.entityId, r2.id));
    expect(audits.map((a) => a.action)).toEqual(["qualification_request.create", "qualification_request.deny"]);
  });

  test("listMyQualificationRequests returns only the caller's requests", async () => {
    await run((tx) => requestQualification(other, tx, motors));
    const mine = await run((tx) => listMyQualificationRequests(deputy, tx));
    expect(mine.length).toBeGreaterThan(0);
    expect(mine.every((r) => r.userId === deputy.userId)).toBe(true);
    const theirs = await run((tx) => listMyQualificationRequests(other, tx));
    expect(theirs.map((r) => r.userId)).toEqual([other.userId]);
  });

  test("visibility and self-grant are refused", async () => {
    await expect(run((tx) => grantQualification(deputy, tx, deputy.userId, motors))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => listUserQualifications(deputy, tx, other.userId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => qualificationHolderCount(deputy, tx, k9))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => listMyQualifications(vendor, tx))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => requestQualification(vendor, tx, k9))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await run((tx) => listUserQualifications(coord, tx, deputy.userId))).toHaveLength(1);
  });

  test("grant, revoke, holder count and revoking an unheld flag", async () => {
    await run((tx) => grantQualification(coord, tx, other.userId, k9));
    expect(await run((tx) => qualificationHolderCount(coord, tx, k9))).toBe(2);
    const revoked = await run((tx) => revokeQualification(coord, tx, other.userId, k9));
    expect(revoked.revokedAt).not.toBeNull();
    expect(await run((tx) => qualificationHolderCount(coord, tx, k9))).toBe(1);
    expect(await get().db.select().from(userQualifications).where(eq(userQualifications.userId, other.userId))).toHaveLength(1);
    expect(await run((tx) => listUserQualifications(coord, tx, other.userId))).toHaveLength(0);
    const audits = await get().db.select().from(auditLog).where(eq(auditLog.entityId, other.userId));
    expect(audits.map((a) => a.action)).toEqual(["user.qualification_grant", "user.qualification_revoke"]);
    await expect(run((tx) => revokeQualification(coord, tx, other.userId, k9))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => revokeQualification(coord, tx, other.userId, motors))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a deactivated qualification cannot be granted or requested", async () => {
    const q = await run((tx) => createQualification(coord, tx, { name: "Drone" }));
    await run((tx) => setQualificationActive(coord, tx, q.id, false));
    await expect(run((tx) => grantQualification(coord, tx, other.userId, q.id))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => requestQualification(other, tx, q.id))).rejects.toBeInstanceOf(ValidationError);
    await run((tx) => setQualificationActive(coord, tx, q.id, true));
    expect((await run((tx) => grantQualification(coord, tx, other.userId, q.id))).qualificationId).toBe(q.id);
  });

  test("createUser with two qualification ids grants both, audited with the creator", async () => {
    const { db } = get();
    const u = await run((tx) =>
      createUser(coord, tx, {
        email: "new@example.test",
        name: "New",
        phone: null,
        role: "personnel",
        rankId: null,
        badgeNumber: null,
        qualificationIds: [k9, src],
      }),
    );
    const grants = await db.select().from(userQualifications).where(eq(userQualifications.userId, u.id));
    expect(grants.map((g) => g.qualificationId).sort(byText)).toEqual([k9, src].sort(byText));
    expect(grants.every((g) => g.grantedBy === coord.userId)).toBe(true);
    const audits = await db.select().from(auditLog).where(eq(auditLog.entityId, u.id));
    expect(audits.filter((a) => a.action === "user.qualification_grant")).toHaveLength(2);
    expect(audits.every((a) => a.actorUserId === coord.userId)).toBe(true);
  });
});
