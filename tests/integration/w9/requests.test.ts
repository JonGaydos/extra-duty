import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { auditLog, notifications, qualifications, userQualifications, w9RequestPeople, w9s } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { signUp } from "@/domain/assignments/signup";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { agencyInstant } from "@/domain/time/agency-time";
import { createW9Request, listW9Requests, readW9Lock, w9RenewalRemindersTick, w9RequestDetail } from "@/domain/w9/requests";
import { reviewW9, uploadW9 } from "@/domain/w9/w9";
import { createLocalStorage } from "@/lib/storage/local";
import type { Storage } from "@/lib/storage";

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("renewal ".repeat(20))]);
// Asked on Jan 5, due Jan 31 (agency dates).
const ASKED = agencyInstant(2027, 1, 5, 10, 0);
const AFTER_DUE = agencyInstant(2027, 2, 1, 9, 0);

describe("W-9 renewal requests", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let storage: Storage;
  let csoA: Actor;
  let csoB: Actor;
  let deputy: Actor;
  let vendor: Actor;

  beforeAll(async () => {
    f = await setupFixture(get().db, "renew");
    storage = createLocalStorage(await mkdtemp(join(tmpdir(), "extra-duty-w9-renew-")));
    csoA = await f.person("CSO");
    csoB = await f.person("CSO");
    deputy = await f.person();
    vendor = (await makeUser(get().db, "vendor", "renew-vendor@example.test")).actor;
    // Their approved W-9s are from last year, before any request.
    await get().db.update(w9s).set({ uploadedAt: agencyInstant(2026, 1, 10, 9, 0) });
  });

  /** Uploads made in a test are dated as if made on `at`. */
  const dated = (w9Id: string, at: Date) => get().db.update(w9s).set({ uploadedAt: at }).where(eq(w9s.id, w9Id));

  const ask = (audience: Parameters<typeof createW9Request>[2]["audience"], now = ASKED) =>
    f.run((tx) => createW9Request(f.coord, tx, { audience, dueOn: "2027-01-31", note: "New IRS revision" }, now));

  test("only staff ask; the due date must be after today", async () => {
    await expect(f.run((tx) => createW9Request(deputy, tx, { audience: { kind: "everyone" }, dueOn: "2027-01-31" }, ASKED))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => createW9Request(f.coord, tx, { audience: { kind: "everyone" }, dueOn: "2027-01-05" }, ASKED))).rejects.toBeInstanceOf(ValidationError);
    await expect(f.run((tx) => createW9Request(f.coord, tx, { audience: { kind: "users", userIds: [vendor.userId] }, dueOn: "2027-01-31" }, ASKED))).rejects.toBeInstanceOf(ValidationError);
  });

  test("a rank request asks everyone with the rank, tells them the due date and note, and is audited", async () => {
    const req = await ask({ kind: "rank", rankId: f.rank["CSO"] });
    const people = (await get().db.select().from(w9RequestPeople).where(eq(w9RequestPeople.requestId, req.id))).map((p) => p.userId);
    expect(people).toEqual(expect.arrayContaining([csoA.userId, csoB.userId]));
    expect(people).not.toContain(deputy.userId);
    const [note] = await get().db.select().from(notifications).where(and(eq(notifications.userId, csoA.userId), eq(notifications.type, "w9.renewal_requested")));
    expect(note.body).toContain("Jan 31, 2027");
    expect(note.body).toContain("New IRS revision");
    expect(await get().db.select().from(auditLog).where(and(eq(auditLog.action, "w9.request"), eq(auditLog.entityId, req.id)))).toHaveLength(1);
    expect(req.audienceLabel).toBe("Rank: CSO");
  });

  test("before the due date nobody is locked; after it, those without a W-9 approved since are", async () => {
    expect(await f.run((tx) => readW9Lock(tx, csoA.userId, ASKED))).toEqual({ locked: false, message: "" });
    // CSO A uploads after the request and is approved; CSO B uploads but stays pending.
    const a = await f.run((tx) => uploadW9(csoA, tx, PDF, "w9.pdf", storage));
    await dated(a.id, agencyInstant(2027, 1, 10, 9, 0));
    await f.run((tx) => reviewW9(f.coord, tx, a.id, { decision: "approve", signedOn: "2026-11-20", formRevision: "March 2024" }));
    const b = await f.run((tx) => uploadW9(csoB, tx, PDF, "w9.pdf", storage));
    await dated(b.id, agencyInstant(2027, 1, 12, 9, 0));
    expect(await f.run((tx) => readW9Lock(tx, csoA.userId, AFTER_DUE))).toEqual({ locked: false, message: "" });
    expect(await f.run((tx) => readW9Lock(tx, csoB.userId, AFTER_DUE))).toEqual({ locked: true, message: "A new W-9 was due Jan 31" });
    // Someone never asked is not locked by it.
    expect(await f.run((tx) => readW9Lock(tx, deputy.userId, AFTER_DUE))).toEqual({ locked: false, message: "" });
  });

  test("the lock shows on sign-up", async () => {
    const { job, positionId } = await f.mkJob({ count: 2 });
    const err = await f.run((tx) => signUp(csoB, tx, positionId, { warningVersion: 1, jobId: job.id, now: AFTER_DUE })).catch((e: unknown) => e);
    // The CSO rank cannot work a Deputy Sheriff spot either; the W-9 rule is listed with its own message.
    expect(err).toBeInstanceOf(RuleViolation);
    expect((err as RuleViolation).checks).toContainEqual({ check: "w9", ok: false, message: "A new W-9 was due Jan 31" });
  });

  test("staff see who is done, pending, rejected and missing", async () => {
    const flag = (await get().db.insert(qualifications).values({ name: "Renewal Flag" }).returning())[0];
    await get().db.insert(userQualifications).values({ userId: deputy.userId, qualificationId: flag.id });
    await ask({ kind: "flag", qualificationId: flag.id });
    const list = await f.run((tx) => listW9Requests(f.coord, tx, AFTER_DUE));
    const rank = list.find((r) => r.audienceLabel === "Rank: CSO")!;
    expect(rank.counts).toMatchObject({ done: 1, pending: 1 });
    expect(rank.overdue).toBe(true);
    const detail = await f.run((tx) => w9RequestDetail(f.coord, tx, rank.id));
    expect(detail.people.find((p) => p.userId === csoA.userId)!.status).toBe("done");
    expect(detail.people.find((p) => p.userId === csoB.userId)!.status).toBe("pending");
    await expect(f.run((tx) => listW9Requests(deputy, tx))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("reminders go a week before and the day before, once each, only to people not done", async () => {
    const r = await f.run((tx) => createW9Request(f.coord, tx, { audience: { kind: "users", userIds: [deputy.userId, csoA.userId] }, dueOn: "2027-03-31" }, agencyInstant(2027, 3, 1, 9, 0)));
    const a = await f.run((tx) => uploadW9(csoA, tx, PDF, "w9.pdf", storage));
    await dated(a.id, agencyInstant(2027, 3, 2, 9, 0));
    await f.run((tx) => reviewW9(f.coord, tx, a.id, { decision: "approve", signedOn: "2026-11-02", formRevision: "March 2024" }));
    const reminders = async () =>
      (await get().db.select().from(notifications).where(and(eq(notifications.type, "w9.renewal_reminder")))).filter((n) => n.body?.includes("Mar 31, 2027")).map((n) => n.userId);
    await f.run((tx) => w9RenewalRemindersTick(tx, agencyInstant(2027, 3, 20, 8, 0)));
    expect(await reminders()).toEqual([]);
    await f.run((tx) => w9RenewalRemindersTick(tx, agencyInstant(2027, 3, 24, 8, 0)));
    await f.run((tx) => w9RenewalRemindersTick(tx, agencyInstant(2027, 3, 25, 8, 0)));
    expect(await reminders()).toEqual([deputy.userId]);
    await f.run((tx) => w9RenewalRemindersTick(tx, agencyInstant(2027, 3, 30, 8, 0)));
    expect(await reminders()).toEqual([deputy.userId, deputy.userId]);
    expect(r.dueOn).toBe("2027-03-31");
  });
});
