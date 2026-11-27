import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import { auditLog, notifications, w9s } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { CATALOG } from "@/domain/notifications/catalog";
import { approvedW9, auditGrandfatheredW9s, currentW9, pendingW9Reviews, readW9, reviewW9, uploadW9, uploadW9For, w9History } from "@/domain/w9/w9";
import { createLocalStorage } from "@/lib/storage/local";
import type { Storage } from "@/lib/storage";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("SSN 123-45-6789 ".repeat(20))]);
const NOW = new Date("2026-11-27T15:00:00Z");

describe("W-9 review", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let storage: Storage;
  let deputy: Actor;
  let other: Actor;
  let coordinator: Actor;
  let puts: Buffer[];

  beforeAll(async () => {
    const { db } = get();
    puts = [];
    const local = createLocalStorage(await mkdtemp(join(tmpdir(), "extra-duty-w9-review-")));
    storage = {
      put: async (k, b, c) => {
        puts.push(b);
        await local.put(k, b, c);
      },
      get: (k) => local.get(k),
    };
    deputy = (await makeUser(db, "personnel", "rev-deputy@example.test", {}, { w9: false })).actor;
    other = (await makeUser(db, "personnel", "rev-other@example.test", {}, { w9: false })).actor;
    coordinator = (await makeUser(db, "coordinator", "rev-coord@example.test", {}, { w9: false })).actor;
  });

  test("a new W-9 starts pending and shows on the review list", async () => {
    const { db } = get();
    const row = await db.transaction((tx) => uploadW9(deputy, tx, PDF, "w9.pdf", storage));
    expect(row.status).toBe("pending");
    expect(row.uploadedBy).toBeNull();
    const pending = await db.transaction((tx) => pendingW9Reviews(tx));
    expect(pending.map((p) => p.w9Id)).toContain(row.id);
    expect(await db.transaction((tx) => approvedW9(tx, deputy.userId))).toBeNull();
  });

  test("staff upload for a person uses the same encryption, starts pending and names the uploader", async () => {
    const { db } = get();
    const before = puts.length;
    const row = await db.transaction((tx) => uploadW9For(coordinator, tx, other.userId, PDF, storage));
    expect(puts).toHaveLength(before + 1);
    expect(puts.at(-1)!.includes(Buffer.from("123-45-6789"))).toBe(false);
    expect(row).toMatchObject({ userId: other.userId, status: "pending", uploadedBy: coordinator.userId, current: true });
    const read = await db.transaction((tx) => readW9(other, tx, other.userId, storage));
    expect(read.body.equals(PDF)).toBe(true);
    await expect(db.transaction((tx) => uploadW9For(deputy, tx, other.userId, PDF, storage))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("only staff review, and a rejection needs a reason", async () => {
    const { db } = get();
    const w9 = (await db.transaction((tx) => currentW9(tx, deputy.userId)))!;
    await expect(db.transaction((tx) => reviewW9(deputy, tx, w9.id, { decision: "reject", reason: "x" }, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => reviewW9(coordinator, tx, w9.id, { decision: "reject", reason: "  " }, NOW))).rejects.toThrow(ValidationError);
  });

  test("a rejection is audited and tells the person why, with a link to upload again", async () => {
    const { db } = get();
    const w9 = (await db.transaction((tx) => currentW9(tx, deputy.userId)))!;
    const row = await db.transaction((tx) => reviewW9(coordinator, tx, w9.id, { decision: "reject", reason: "Line 2 missing" }, NOW));
    expect(row).toMatchObject({ status: "rejected", rejectReason: "Line 2 missing", reviewedBy: coordinator.userId });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.action, "w9.reject"), eq(auditLog.entityId, w9.id)));
    expect(audit.reason).toBe("Line 2 missing");
    const [note] = await db.select().from(notifications).where(and(eq(notifications.userId, deputy.userId), eq(notifications.type, "w9.rejected")));
    expect(note.body).toContain("Line 2 missing");
    expect(note.link).toBe("/profile#w9");
    await expect(db.transaction((tx) => reviewW9(coordinator, tx, w9.id, { decision: "reject", reason: "again" }, NOW))).rejects.toThrow("already reviewed");
  });

  test("approval records the signature date and form revision, is audited and notifies", async () => {
    const { db } = get();
    const fresh = await db.transaction((tx) => uploadW9(deputy, tx, PDF, "w9.pdf", storage));
    await expect(db.transaction((tx) => reviewW9(coordinator, tx, fresh.id, { decision: "approve", signedOn: "2026-12-25", formRevision: "March 2024" }, NOW))).rejects.toThrow("future");
    await expect(db.transaction((tx) => reviewW9(coordinator, tx, fresh.id, { decision: "approve", signedOn: "2026-11-01", formRevision: "" }, NOW))).rejects.toThrow("revision");
    const row = await db.transaction((tx) => reviewW9(coordinator, tx, fresh.id, { decision: "approve", signedOn: "2026-11-01", formRevision: "March 2024" }, NOW));
    expect(row).toMatchObject({ status: "approved", signedOn: "2026-11-01", formRevision: "March 2024" });
    expect((await db.transaction((tx) => approvedW9(tx, deputy.userId)))!.id).toBe(fresh.id);
    expect(await db.select().from(auditLog).where(and(eq(auditLog.action, "w9.approve"), eq(auditLog.entityId, fresh.id)))).toHaveLength(1);
    expect(await db.select().from(notifications).where(and(eq(notifications.userId, deputy.userId), eq(notifications.type, "w9.approved")))).toHaveLength(1);
  });

  test("a newer pending upload does not replace the approved W-9; history keeps every upload", async () => {
    const { db } = get();
    const approved = (await db.transaction((tx) => approvedW9(tx, deputy.userId)))!;
    await db.transaction((tx) => uploadW9(deputy, tx, PDF, "w9.pdf", storage));
    expect((await db.transaction((tx) => approvedW9(tx, deputy.userId)))!.id).toBe(approved.id);
    const history = await db.transaction((tx) => w9History(coordinator, tx, deputy.userId));
    expect(history.map((h) => h.status)).toEqual(["pending", "approved", "rejected"]);
    await expect(db.transaction((tx) => w9History(other, tx, deputy.userId))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("W-9 notifications never reach vendors", () => {
    for (const key of ["w9.approved", "w9.rejected"] as const) expect(CATALOG[key].groups).not.toContain("vendor");
  });

  test("grandfathered W-9s get one system audit entry, once", async () => {
    const { db } = get();
    const g = (await makeUser(db, "personnel", "rev-grand@example.test", {}, { w9: false })).actor;
    const row = await db.transaction((tx) => uploadW9(g, tx, PDF, "w9.pdf", storage));
    await db.update(w9s).set({ status: "approved", grandfathered: true }).where(eq(w9s.id, row.id));
    expect(await db.transaction((tx) => auditGrandfatheredW9s(tx))).toBeGreaterThanOrEqual(1);
    expect(await db.transaction((tx) => auditGrandfatheredW9s(tx))).toBe(0);
    const audits = await db.select().from(auditLog).where(and(eq(auditLog.action, "w9.grandfather"), eq(auditLog.entityId, row.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBeNull();
    expect(audits[0].after).toMatchObject({ status: "approved", signedOn: null });
  });
});
