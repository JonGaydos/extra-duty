import { beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq, sql } from "drizzle-orm";

const push = vi.hoisted(() => ({ setVapidDetails: vi.fn(), sendNotification: vi.fn() }));
vi.mock("web-push", () => ({ ...push, default: push }));

import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, messageRecipients, messages, notificationPrefs, notifications, pushSubscriptions, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { getMessage, hideMessages, listInbox, listSent, markRead, messageCoordinators, sendMessage } from "@/domain/messages/messages";
import { updateSettings } from "@/domain/settings/settings";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE } from "@/jobs/boss";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

describe("message center", () => {
  const get = useTestDb();
  const { drainNotifications: drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let n = 0;

  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);
  const person = async (rankName = "Deputy Sheriff", extra: Partial<typeof users.$inferInsert> = {}) => {
    const p = await f.person(rankName);
    if (Object.keys(extra).length) await get().db.update(users).set(extra).where(eq(users.id, p.userId));
    return p;
  };
  const vendorUser = async () => (await makeUser(get().db, "vendor", `mv${++n}@example.test`)).actor;
  const sub = (userId: string) => get().db.insert(pushSubscriptions).values({ userId, endpoint: `https://push.example.test/${userId}`, keys: { p256dh: "k", auth: "a" } });
  const send = (actor: Actor, audiences: Parameters<typeof sendMessage>[2]["audiences"], extra: Record<string, unknown> = {}) =>
    run((tx) => sendMessage(actor, tx, { audiences, subject: "Parking", body: "Use lot B on Friday.", ...extra }));
  const recipients = async (id: string) =>
    (await get().db.select({ u: messageRecipients.userId }).from(messageRecipients).where(eq(messageRecipients.messageId, id))).map((r) => r.u).sort();
  const inbox = (a: Actor, o: { text?: string; unreadOnly?: boolean; page?: number } = {}) => run((tx) => listInbox(a, tx, { page: 1, ...o }));

  beforeAll(async () => {
    f = await setupFixture(get().db, "mc");
    admin = (await makeUser(get().db, "admin", "mc-admin@example.test")).actor;
  });
  beforeEach(async () => {
    setEmailSender(mail);
    process.env.VAPID_PUBLIC_KEY = "pub";
    process.env.VAPID_PRIVATE_KEY = "priv";
    process.env.VAPID_SUBJECT = "mailto:ops@example.test";
    await run((tx) => updateSettings(admin, tx, { personnelCanMessageAll: true }));
    await drain();
    await get().db.execute(sql`delete from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${NOTIFY_PUSH_QUEUE})`);
    mail.clear();
    push.sendNotification.mockReset();
  });

  test("a deputy messages two users: both get an inbox row and a push, the sender does not", async () => {
    const [deputy, a, b, other] = [await person(), await person(), await person(), await person()];
    for (const p of [deputy, a, b, other]) await sub(p.userId);
    const m = await send(deputy, [{ kind: "users", userIds: [a.userId, b.userId, deputy.userId] }]);
    expect(await recipients(m.id)).toEqual([a.userId, b.userId].sort());
    expect(m.recipientCount).toBe(2);
    await drain();
    expect(push.sendNotification.mock.calls.map((c) => c[0].endpoint).sort()).toEqual([`https://push.example.test/${a.userId}`, `https://push.example.test/${b.userId}`].sort());
    const rows = await get().db.select().from(notifications).where(eq(notifications.type, "message.received"));
    expect(rows.filter((r) => r.link === `/messages/${m.id}`).map((r) => r.userId).sort()).toEqual([a.userId, b.userId].sort());
    expect(rows.find((r) => r.userId === a.userId)).toMatchObject({ title: "Parking", body: "Use lot B on Friday." });
    expect(await inbox(deputy)).toHaveLength(0);
    expect((await inbox(a))[0]).toMatchObject({ messageId: m.id, subject: "Parking", read: false, senderName: expect.any(String) });
  });

  test("all: allowed for a deputy when the setting is on, refused when off, always allowed for coordinators; never reaches vendors or inactive users", async () => {
    const deputy = await person();
    const live = await person();
    const gone = await person("Deputy Sheriff", { active: false });
    const v = await vendorUser();
    const m = await send(deputy, [{ kind: "all" }]);
    const got = await recipients(m.id);
    expect(got).toContain(live.userId);
    expect(got).not.toContain(gone.userId);
    expect(got).not.toContain(v.userId);
    expect(got).not.toContain(deputy.userId);
    await run((tx) => updateSettings(f.coord, tx, { personnelCanMessageAll: false }));
    await expect(send(deputy, [{ kind: "all" }])).rejects.toBeInstanceOf(ForbiddenError);
    await expect(send(f.coord, [{ kind: "all" }])).resolves.toBeDefined();
    await expect(send(deputy, [{ kind: "users", userIds: [live.userId] }])).resolves.toBeDefined();
  });

  test("email follows the recipient's choice for non-coordinator senders and is mandatory for coordinators", async () => {
    const deputy = await person();
    const on = await person();
    const off = await person();
    await get().db.insert(notificationPrefs).values({ userId: on.userId, type: "message.received", email: true, push: false });
    await send(deputy, [{ kind: "users", userIds: [on.userId, off.userId] }], { body: "Bring your radio." });
    await drain();
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].to).toEqual([(await get().db.select().from(users).where(eq(users.id, on.userId)))[0].email]);
    expect(mail.sent[0].text).toContain("Bring your radio.");
    expect(mail.sent[0].subject).toBe("Parking");
    expect(mail.sent[0].text).toContain("/messages/");
    mail.clear();
    await send(f.coord, [{ kind: "users", userIds: [on.userId, off.userId] }], { body: "Mandatory meeting." });
    await drain();
    expect(mail.sent).toHaveLength(2);
    expect(mail.sent.every((m) => m.text?.includes("Mandatory meeting."))).toBe(true);
  });

  test("vendors cannot send, and a users audience naming a vendor or unknown id is refused before any write", async () => {
    const deputy = await person();
    const v = await vendorUser();
    const a = await person();
    await expect(send(v, [{ kind: "users", userIds: [a.userId] }])).rejects.toBeInstanceOf(ForbiddenError);
    const before = (await get().db.select().from(messages)).length;
    await expect(send(deputy, [{ kind: "users", userIds: [a.userId, v.userId] }])).rejects.toBeInstanceOf(ValidationError);
    await expect(send(deputy, [{ kind: "users", userIds: [a.userId, "00000000-0000-7000-8000-000000000000"] }])).rejects.toBeInstanceOf(ValidationError);
    expect((await get().db.select().from(messages)).length).toBe(before);
  });

  test("the job audience is signed-up, pending short and backup people only, for any personnel", async () => {
    const deputy = await person();
    const { job, positionId } = await f.mkJob({ count: 5 });
    const put = async (status: (typeof assignments.$inferInsert)["status"]) => {
      const p = await person();
      await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status });
      return p.userId;
    };
    const signed = await put("signed_up");
    const backup = await put("backup");
    const pending = await put("pending_short");
    await put("canceled");
    await put("removed");
    const bystander = await person();
    const m = await send(deputy, [{ kind: "job", jobId: job.id }], { jobId: job.id });
    expect(await recipients(m.id)).toEqual([signed, backup, pending].sort());
    expect(await recipients(m.id)).not.toContain(bystander.userId);
    expect(m.jobId).toBe(job.id);
    await expect(send(deputy, [{ kind: "job", jobId: "00000000-0000-7000-8000-000000000000" }])).rejects.toBeInstanceOf(NotFoundError);
  });

  test("rank and coordinator audiences; overlapping audiences send one copy each", async () => {
    const deputy = await person();
    const cso = await person("CSO");
    const posse = await person("Posse");
    const m = await send(deputy, [{ kind: "rank", rankIds: [f.rank["CSO"]] }, { kind: "users", userIds: [cso.userId, posse.userId] }, { kind: "rank", rankIds: [f.rank["CSO"]] }]);
    const rows = await get().db.select().from(messageRecipients).where(eq(messageRecipients.messageId, m.id));
    const mine = rows.filter((r) => [cso.userId, posse.userId].includes(r.userId));
    expect(mine).toHaveLength(2);
    expect(new Set(rows.map((r) => r.userId)).size).toBe(rows.length);
    const c = await send(deputy, [{ kind: "coordinators" }]);
    expect(await recipients(c.id)).toContain(f.coord.userId);
    expect(await recipients(c.id)).toContain(admin.userId);
    expect(await recipients(c.id)).not.toContain(cso.userId);
  });

  test("messageCoordinators sends a question about a job with the job attached", async () => {
    const deputy = await person();
    const { job } = await f.mkJob();
    const m = await run((tx) => messageCoordinators(deputy, tx, { jobId: job.id, body: "Is a vest needed?" }));
    expect(m.subject).toBe(`Question about job #${job.number}: ${job.title}`);
    expect(m.jobId).toBe(job.id);
    expect(await recipients(m.id)).toContain(f.coord.userId);
    await expect(run((tx) => messageCoordinators(deputy, tx, { jobId: "00000000-0000-7000-8000-000000000000", body: "Hi" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("a reply goes to the original sender; only a recipient or the sender may reply", async () => {
    const [s, r, stranger] = [await person(), await person(), await person()];
    const orig = await send(s, [{ kind: "users", userIds: [r.userId] }]);
    const reply = await run((tx) => sendMessage(r, tx, { audiences: [], subject: "Re: Parking", body: "Got it.", replyToMessageId: orig.id }));
    expect(reply.replyToMessageId).toBe(orig.id);
    expect(await recipients(reply.id)).toEqual([s.userId]);
    await expect(run((tx) => sendMessage(stranger, tx, { audiences: [], subject: "Re", body: "x", replyToMessageId: orig.id }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => sendMessage(r, tx, { audiences: [], subject: "Re", body: "x", replyToMessageId: "00000000-0000-7000-8000-000000000000" }))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("subject is 1 to 200 characters and body 1 to 10,000, trimmed", async () => {
    const [s, r] = [await person(), await person()];
    const to = [{ kind: "users" as const, userIds: [r.userId] }];
    await expect(send(s, to, { subject: "   " })).rejects.toBeInstanceOf(ValidationError);
    await expect(send(s, to, { subject: "x".repeat(201) })).rejects.toBeInstanceOf(ValidationError);
    await expect(send(s, to, { body: "  " })).rejects.toBeInstanceOf(ValidationError);
    await expect(send(s, to, { body: "x".repeat(10_001) })).rejects.toBeInstanceOf(ValidationError);
    await expect(send(s, [])).rejects.toBeInstanceOf(ValidationError);
    const ok = await send(s, to, { subject: ` ${"x".repeat(200)} `, body: ` ${"y".repeat(10_000)} ` });
    expect(ok.subject).toHaveLength(200);
    expect(ok.body).toHaveLength(10_000);
  });

  test("inbox lists newest first with search, unread filter and 25 per page; mark unread works", async () => {
    const [s, r] = [await person(), await person()];
    const ids: string[] = [];
    for (let i = 0; i < 27; i++) ids.push((await send(s, [{ kind: "users", userIds: [r.userId] }], { subject: `Note ${i}`, body: i === 3 ? "The Radio frequency changed" : "plain" })).id);
    const p1 = await inbox(r);
    const p2 = await inbox(r, { page: 2 });
    expect(p1).toHaveLength(25);
    expect(p2).toHaveLength(2);
    expect(p1[0].messageId).toBe(ids[26]);
    expect(p1[0].snippet).toBe("plain");
    expect((await inbox(r, { text: "radio FREQ" })).map((x) => x.messageId)).toEqual([ids[3]]);
    expect((await inbox(r, { text: "note 1" })).length).toBeGreaterThan(1);
    expect(await inbox(r, { text: "100%" })).toHaveLength(0);
    await run((tx) => markRead(r, tx, [ids[3], ids[4]], true));
    expect((await inbox(r, { unreadOnly: true, page: 1 })).map((x) => x.messageId)).not.toContain(ids[3]);
    expect((await inbox(r)).find((x) => x.messageId === ids[3])?.read).toBe(true);
    await run((tx) => markRead(r, tx, [ids[3]], false));
    expect((await inbox(r, { text: "radio" }))[0].read).toBe(false);
    await run((tx) => markRead(s, tx, [ids[3]], true));
    expect((await inbox(r, { text: "radio" }))[0].read).toBe(false);
  });

  test("hiding removes the message from that user's inbox only, not Sent, the other recipient or the audit", async () => {
    const [s, a, b] = [await person(), await person(), await person()];
    const m = await send(s, [{ kind: "users", userIds: [a.userId, b.userId] }]);
    await run((tx) => hideMessages(a, tx, [m.id]));
    expect(await inbox(a)).toHaveLength(0);
    expect(await inbox(b)).toHaveLength(1);
    const sent = await run((tx) => listSent(s, tx, { page: 1 }));
    expect(sent[0]).toMatchObject({ messageId: m.id, subject: "Parking", recipientCount: 2 });
    expect(await get().db.select().from(messageRecipients).where(and(eq(messageRecipients.messageId, m.id), eq(messageRecipients.userId, a.userId)))).toHaveLength(1);
    await run((tx) => hideMessages(s, tx, [m.id]));
    expect(await inbox(b)).toHaveLength(1);
    const audit = await get().db.select().from(auditLog).where(and(eq(auditLog.entityType, "message"), eq(auditLog.entityId, m.id)));
    expect(audit.map((r) => r.action).sort()).toEqual(["message.hide", "message.send"]);
  });

  test("the send audit records the id, audience kinds and recipient count, not the body", async () => {
    const [s, r] = [await person(), await person()];
    const m = await send(s, [{ kind: "users", userIds: [r.userId] }], { body: "Secret plan details" });
    const [row] = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, m.id), eq(auditLog.action, "message.send")));
    expect(row.actorUserId).toBe(s.userId);
    expect(row.after).toEqual({ audiences: ["users"], recipientCount: 1 });
    expect(JSON.stringify(row)).not.toContain("Secret plan details");
  });
  test("a reply by the original sender goes to the original recipients, minus vendors and inactive users", async () => {
    const [s, a, b, c] = [await person(), await person(), await person(), await person()];
    const orig = await send(s, [{ kind: "users", userIds: [a.userId, b.userId, c.userId] }]);
    await run((tx) => hideMessages(b, tx, [orig.id]));
    await get().db.update(users).set({ active: false }).where(eq(users.id, c.userId));
    const reply = await run((tx) => sendMessage(s, tx, { audiences: [], subject: "Re: Parking", body: "Update.", replyToMessageId: orig.id }));
    expect(await recipients(reply.id)).toEqual([a.userId, b.userId].sort());
    // a recipient who hid the original can still reply to the sender
    const back = await run((tx) => sendMessage(b, tx, { audiences: [], subject: "Re", body: "Thanks.", replyToMessageId: orig.id }));
    expect(await recipients(back.id)).toEqual([s.userId]);
  });

  test("audiences must be a non-empty array of objects with a known kind; page must be a positive integer", async () => {
    const [s, r] = [await person(), await person()];
    await expect(send(s, undefined as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(send(s, "all" as never)).rejects.toBeInstanceOf(ValidationError);
    await expect(send(s, [null as never])).rejects.toBeInstanceOf(ValidationError);
    await expect(send(s, [{ kind: "nobody" } as never])).rejects.toBeInstanceOf(ValidationError);
    await send(s, [{ kind: "users", userIds: [r.userId] }]);
    for (const page of [0, -1, 1.5, Infinity, NaN]) {
      await expect(inbox(r, { page })).rejects.toBeInstanceOf(ValidationError);
      await expect(run((tx) => listSent(s, tx, { page }))).rejects.toBeInstanceOf(ValidationError);
    }
  });

  test("getMessage: sender, recipient and a recipient who hid it can read; a stranger and a malformed id get not found; a vendor is forbidden", async () => {
    const [s, a, b, stranger] = [await person(), await person(), await person(), await person()];
    const v = await vendorUser();
    const m = await send(s, [{ kind: "users", userIds: [a.userId, b.userId] }], { body: "Full text here." });
    await run((tx) => hideMessages(b, tx, [m.id]));
    for (const reader of [s, a, b]) expect((await run((tx) => getMessage(reader, tx, m.id))).body).toBe("Full text here.");
    await expect(run((tx) => getMessage(stranger, tx, m.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => getMessage(a, tx, "not-an-id"))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => getMessage(v, tx, m.id))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a vendor cannot read an inbox or Sent; hiding or marking another user's message changes nothing", async () => {
    const [s, a, other] = [await person(), await person(), await person()];
    const v = await vendorUser();
    await expect(inbox(v)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => listSent(v, tx, { page: 1 }))).rejects.toBeInstanceOf(ForbiddenError);
    const m = await send(s, [{ kind: "users", userIds: [a.userId] }]);
    await run((tx) => hideMessages(other, tx, [m.id]));
    await run((tx) => markRead(other, tx, [m.id], true));
    const [row] = await get().db.select().from(messageRecipients).where(and(eq(messageRecipients.messageId, m.id), eq(messageRecipients.userId, a.userId)));
    expect(row.hiddenAt).toBeNull();
    expect(row.readAt).toBeNull();
  });

});
