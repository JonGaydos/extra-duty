import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { call, sessionToken, bearer } from "../api/helpers";
import { auditLog, messageRecipients, notifications } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { signUp } from "@/domain/assignments/signup";
import { coordinatorTodo } from "@/domain/coordinator/views";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import {
  acknowledgeMessage,
  ackStatusFor,
  ackTracking,
  ackTrackingCsv,
  overdueAcknowledgements,
  pendingAcknowledgements,
  readAckLock,
  remindUnacknowledged,
} from "@/domain/messages/acknowledgements";
import { sendMessage, type SendInput } from "@/domain/messages/messages";
import { POST as postMessage } from "@/app/api/v1/messages/route";
import { POST as postAck } from "@/app/api/v1/messages/[id]/acknowledge/route";

const byText = (x: string, y: string) => x.localeCompare(y);
const NOW = new Date("2035-02-01T18:00:00Z");
const LATER = new Date("2035-02-20T18:00:00Z");

describe("messages that require acknowledgement", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let a: Actor;
  let b: Actor;
  let c: Actor;

  beforeAll(async () => {
    f = await setupFixture(get().db, "ack");
    a = await f.person();
    b = await f.person();
    c = await f.person();
  });

  const send = (actor: Actor, input: Partial<SendInput> = {}, now = NOW) =>
    f.run((tx) =>
      sendMessage(actor, tx, { audiences: [{ kind: "users", userIds: [a.userId, b.userId, c.userId] }], subject: "New radio policy", body: "Read the policy.", ...input }, now),
    );

  test("only coordinators and admins may require acknowledgement", async () => {
    await expect(send(a, { audiences: [{ kind: "users", userIds: [b.userId] }], ack: {} })).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("locking sign-ups needs a due date, and the due date cannot be in the past", async () => {
    await expect(send(f.coord, { ack: { lockSignups: true } })).rejects.toBeInstanceOf(ValidationError);
    await expect(send(f.coord, { ack: { dueOn: "2035-01-15" } })).rejects.toBeInstanceOf(ValidationError);
  });

  test("recipients see it pending, oldest first, until they acknowledge it; acknowledging is final and audited", async () => {
    const first = await send(f.coord, { subject: "First policy", ack: {} });
    const second = await send(f.coord, { subject: "Second policy", ack: { dueOn: "2035-02-10" } }, new Date(NOW.getTime() + 60_000));
    expect(first.requiresAck).toBe(true);
    expect(second.ackDueAt?.toISOString()).toBe("2035-02-11T05:59:59.999Z");

    const pending = await f.run((tx) => pendingAcknowledgements(a, tx));
    const mine = pending.filter((p) => p.messageId === first.id || p.messageId === second.id);
    expect(mine.map((p) => p.subject)).toEqual(["First policy", "Second policy"]);
    expect(mine[0].senderName).toBeTruthy();

    const at = new Date(NOW.getTime() + 3_600_000);
    const done = await f.run((tx) => acknowledgeMessage(a, tx, first.id, at));
    expect(done.acknowledgedAt.toISOString()).toBe(at.toISOString());
    // A second acknowledgement keeps the first time.
    const again = await f.run((tx) => acknowledgeMessage(a, tx, first.id, LATER));
    expect(again.acknowledgedAt.toISOString()).toBe(at.toISOString());
    expect((await f.run((tx) => ackStatusFor(a, tx, first.id)))?.acknowledgedAt?.toISOString()).toBe(at.toISOString());

    const left = await f.run((tx) => pendingAcknowledgements(a, tx));
    expect(left.some((p) => p.messageId === first.id)).toBe(false);
    expect(left.some((p) => p.messageId === second.id)).toBe(true);

    const audits = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "message.acknowledge"), eq(auditLog.entityId, first.id)));
    expect(audits).toHaveLength(1);
    expect(audits[0].actorUserId).toBe(a.userId);
    // Opening and acknowledging marks it read too.
    const [row] = await get().db.select().from(messageRecipients).where(and(eq(messageRecipients.messageId, first.id), eq(messageRecipients.userId, a.userId)));
    expect(row.readAt).not.toBeNull();
  });

  test("only a recipient acknowledges, and only a message that asks for it", async () => {
    const m = await send(f.coord, { ack: {} });
    const plain = await send(f.coord);
    const outsider = await f.person();
    await expect(f.run((tx) => acknowledgeMessage(outsider, tx, m.id))).rejects.toThrow(/not found/i);
    await expect(f.run((tx) => acknowledgeMessage(a, tx, plain.id))).rejects.toBeInstanceOf(ValidationError);
  });

  test("staff track N of M, who acknowledged with times and who has not, and export it as CSV", async () => {
    const m = await send(f.coord, { subject: "=HYPERLINK(\"x\")", ack: { dueOn: "2035-02-10" } });
    await f.run((tx) => acknowledgeMessage(b, tx, m.id, new Date("2035-02-02T15:30:00Z")));
    const t = await f.run((tx) => ackTracking(f.coord, tx, m.id));
    expect(t.total).toBe(3);
    expect(t.acknowledged.map((x) => x.userId)).toEqual([b.userId]);
    expect(t.acknowledged[0].at.toISOString()).toBe("2035-02-02T15:30:00.000Z");
    expect(t.pending.map((x) => x.userId).sort(byText)).toEqual([a.userId, c.userId].sort(byText));
    await expect(f.run((tx) => ackTracking(a, tx, m.id))).rejects.toBeInstanceOf(ForbiddenError);

    const csv = await f.run((tx) => ackTrackingCsv(f.coord, tx, m.id));
    const lines = csv.trim().split("\r\n");
    expect(lines[0]).toBe("Name,Email,Status,Acknowledged at");
    expect(lines).toHaveLength(4);
    expect(csv).toContain(`Acknowledged,"Feb 2, 2035, 9:30 AM CST"`);
    expect(csv).toContain("Not acknowledged");
    const exported = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "message.ack_export"), eq(auditLog.entityId, m.id)));
    expect(exported).toHaveLength(1);
  });

  test("Remind those who haven't alerts only the people still pending, through the notification path", async () => {
    const m = await send(f.coord, { subject: "Range day rules", ack: {} });
    await f.run((tx) => acknowledgeMessage(a, tx, m.id));
    const n = await f.run((tx) => remindUnacknowledged(f.coord, tx, m.id, LATER));
    expect(n).toBe(2);
    const sent = await get().db.select().from(notifications).where(eq(notifications.type, "message.ack_reminder"));
    const to = sent.filter((r) => r.link === `/messages/${m.id}`).map((r) => r.userId).sort(byText);
    expect(to).toEqual([b.userId, c.userId].sort(byText));
    expect(sent.find((r) => r.link === `/messages/${m.id}`)?.title).toBe("Please acknowledge: Range day rules");
    const audit = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "message.ack_remind"), eq(auditLog.entityId, m.id)));
    expect(audit[0].after).toMatchObject({ reminded: 2 });
    await expect(f.run((tx) => remindUnacknowledged(a, tx, m.id))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("overdue unacknowledged messages appear on the coordinator To-do", async () => {
    const m = await send(f.coord, { subject: "Overdue policy", ack: { dueOn: "2035-02-05" } });
    const before = await f.run((tx) => overdueAcknowledgements(tx, NOW));
    expect(before.some((r) => r.messageId === m.id)).toBe(false);
    const todo = await f.run((tx) => coordinatorTodo(f.coord, tx, LATER));
    expect(todo.overdueAcks.find((r) => r.messageId === m.id)).toMatchObject({ subject: "Overdue policy", acknowledged: 0, total: 3 });
  });

  test("with the lock on, sign-ups lock after the due date until the person acknowledges it", async () => {
    const d = await f.person();
    const m = await f.run((tx) =>
      sendMessage(f.coord, tx, { audiences: [{ kind: "users", userIds: [d.userId] }], subject: "Use of force update", body: "Read it.", ack: { dueOn: "2035-02-10", lockSignups: true } }, NOW),
    );
    expect(await f.run((tx) => readAckLock(tx, d.userId, NOW))).toEqual({ locked: false, message: "" });
    const lock = await f.run((tx) => readAckLock(tx, d.userId, LATER));
    expect(lock).toEqual({ locked: true, message: "Acknowledge the message \"Use of force update\" to sign up again" });

    const { job, positionId } = await f.mkJob();
    const err = await f.run((tx) => signUp(d, tx, positionId, { warningVersion: 1, jobId: job.id, now: LATER })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RuleViolation);
    expect((err as RuleViolation).checks.filter((x) => !x.ok).map((x) => x.check)).toEqual(["message_ack"]);

    await f.run((tx) => acknowledgeMessage(d, tx, m.id, LATER));
    expect((await f.run((tx) => readAckLock(tx, d.userId, LATER))).locked).toBe(false);
  });

  test("without the lock option, a missed due date never locks sign-ups", async () => {
    const d = await f.person();
    await f.run((tx) => sendMessage(f.coord, tx, { audiences: [{ kind: "users", userIds: [d.userId] }], subject: "No lock", body: "Read it.", ack: { dueOn: "2035-02-10" } }, NOW));
    expect((await f.run((tx) => readAckLock(tx, d.userId, LATER))).locked).toBe(false);
  });

  test("the API sends an acknowledgement message and records an acknowledgement", async () => {
    const coordToken = await sessionToken(get().db, f.coord.userId);
    const res = await call(postMessage, "/api/v1/messages", {
      method: "POST",
      headers: { ...bearer(coordToken), "content-type": "application/json" },
      body: JSON.stringify({ audiences: [{ kind: "users", userIds: [c.userId] }], subject: "API policy", body: "Read it.", ack: { dueOn: "2035-12-01" } }),
    });
    expect(res.status, await res.clone().text()).toBe(201);
    const id = (await res.json()).data.id as string;
    const ackRes = await call(postAck, `/api/v1/messages/${id}/acknowledge`, { method: "POST", headers: bearer(await sessionToken(get().db, c.userId)), params: { id } });
    expect(ackRes.status, await ackRes.clone().text()).toBe(200);
    expect((await ackRes.json()).data.acknowledgedAt).toBeTruthy();
  });
});
