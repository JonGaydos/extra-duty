import { and, asc, count, eq, isNotNull, isNull, lte, sql } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { messageRecipients, messages, users } from "@/db/schema";
import { toCsv } from "@/lib/csv";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { emit } from "../notifications/notify";
import { AGENCY_TZ, agencyDateOnly, agencyStamp } from "../time/agency-time";

/**
 * Messages that require acknowledgement (owner decision 2026-11-27). Staff tick "Require acknowledgement" when they
 * send, optionally with a due date and "Lock sign-ups if not acknowledged by the due date". Each recipient reads it
 * and presses "I have read and understand"; that time is recorded, audited and final. Staff track who has and has
 * not, remind those who have not and export the list. Vendors are never messaged here.
 */

/** The compose choices: a due date (YYYY-MM-DD, agency time; the end of that day) and the sign-up lock. */
export type AckOptions = { dueOn?: string | null; lockSignups?: boolean };

export type AckColumns = { requiresAck: boolean; ackDueAt: Date | null; ackLocksSignups: boolean };

const DUE_DAY = new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, month: "short", day: "numeric", year: "numeric" });

/** The due date in words: "Feb 10, 2035" (the due time is the end of that agency day). */
export const dueDay = (dueAt: Date): string => DUE_DAY.format(dueAt);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The message columns for the compose choices, after the checks. `undefined` means no acknowledgement. */
export function ackColumns(actor: Actor, ack: AckOptions | undefined | null, now: Date): AckColumns {
  if (ack === undefined || ack === null) return { requiresAck: false, ackDueAt: null, ackLocksSignups: false };
  if (typeof ack !== "object") throw new ValidationError("The acknowledgement choices are not valid.");
  if (actor.role !== "coordinator" && actor.role !== "admin") throw new ForbiddenError("Only coordinators and admins can require acknowledgement.");
  assertCan(actor, "message.requireAck");
  const dueOn = typeof ack.dueOn === "string" && ack.dueOn.trim() ? ack.dueOn.trim() : null;
  const dueAt = dueOn === null ? null : agencyDateOnly(dueOn, "end");
  if (dueOn !== null && dueAt === null) throw new ValidationError("The due date is not a valid date.");
  if (dueAt && dueAt.getTime() < now.getTime()) throw new ValidationError("The due date cannot be in the past.");
  const lock = ack.lockSignups === true;
  if (lock && !dueAt) throw new ValidationError("Choose a due date to lock sign-ups.");
  return { requiresAck: true, ackDueAt: dueAt, ackLocksSignups: lock };
}

export type PendingAck = { messageId: string; subject: string; senderName: string; sentAt: Date; dueAt: Date | null };

/** The actor's messages still waiting for their acknowledgement, oldest first. Removing one from the inbox does not clear it. */
export async function pendingAcknowledgements(actor: Actor, tx: Tx): Promise<PendingAck[]> {
  if (actor.role === "vendor") return [];
  const rows = await tx
    .select({ messageId: messages.id, subject: messages.subject, senderName: users.name, sentAt: messages.sentAt, dueAt: messages.ackDueAt })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .leftJoin(users, eq(users.id, messages.senderUserId))
    .where(and(eq(messageRecipients.userId, actor.userId), eq(messages.requiresAck, true), isNull(messageRecipients.acknowledgedAt)))
    .orderBy(asc(messages.sentAt), asc(messages.id));
  return rows.map((r) => ({ ...r, senderName: r.senderName ?? "Signal 90" }));
}

async function recipientRow(actor: Actor, tx: Tx, messageId: string) {
  if (typeof messageId !== "string" || !UUID.test(messageId)) throw new NotFoundError("Message not found.");
  const [row] = await tx
    .select({ id: messageRecipients.id, acknowledgedAt: messageRecipients.acknowledgedAt, readAt: messageRecipients.readAt, requiresAck: messages.requiresAck })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .where(and(eq(messageRecipients.messageId, messageId), eq(messageRecipients.userId, actor.userId)));
  return row ?? null;
}

/** The recipient's own acknowledgement of one message, or null when they are not a recipient or it does not ask for one. */
export async function ackStatusFor(actor: Actor, tx: Tx, messageId: string): Promise<{ acknowledgedAt: Date | null } | null> {
  const row = await recipientRow(actor, tx, messageId);
  return row?.requiresAck ? { acknowledgedAt: row.acknowledgedAt } : null;
}

/** "I have read and understand": records the time once, marks it read and audits it. A second press keeps the first time. */
export async function acknowledgeMessage(actor: Actor, tx: Tx, messageId: string, now: Date = new Date()): Promise<{ acknowledgedAt: Date }> {
  assertCan(actor, "message.send");
  const row = await recipientRow(actor, tx, messageId);
  if (!row) throw new NotFoundError("Message not found.");
  if (!row.requiresAck) throw new ValidationError("This message does not ask for an acknowledgement.");
  if (row.acknowledgedAt) return { acknowledgedAt: row.acknowledgedAt };
  const [done] = await tx
    .update(messageRecipients)
    .set({ acknowledgedAt: now, readAt: row.readAt ?? now })
    .where(and(eq(messageRecipients.id, row.id), isNull(messageRecipients.acknowledgedAt)))
    .returning({ acknowledgedAt: messageRecipients.acknowledgedAt });
  if (!done?.acknowledgedAt) {
    const again = await recipientRow(actor, tx, messageId);
    return { acknowledgedAt: again?.acknowledgedAt ?? now };
  }
  await recordAudit(tx, { actor, action: "message.acknowledge", entityType: "message", entityId: messageId, before: { acknowledgedAt: null }, after: { acknowledgedAt: now.toISOString() } });
  return { acknowledgedAt: done.acknowledgedAt };
}

export type AckTracking = {
  messageId: string;
  subject: string;
  dueAt: Date | null;
  locksSignups: boolean;
  remindedAt: Date | null;
  total: number;
  acknowledged: Array<{ userId: string; name: string; email: string; at: Date }>;
  pending: Array<{ userId: string; name: string; email: string }>;
};

async function ackMessage(actor: Actor, tx: Tx, messageId: string) {
  if (actor.role !== "coordinator" && actor.role !== "admin") throw new ForbiddenError("Only coordinators and admins can track acknowledgements.");
  assertCan(actor, "message.requireAck");
  if (typeof messageId !== "string" || !UUID.test(messageId)) throw new NotFoundError("Message not found.");
  const [m] = await tx.select().from(messages).where(eq(messages.id, messageId));
  if (!m?.requiresAck) throw new NotFoundError("Message not found.");
  return m;
}

/** Acknowledged N of M, with who acknowledged (and when, earliest first) and who has not (by name). Staff only. */
export async function ackTracking(actor: Actor, tx: Tx, messageId: string): Promise<AckTracking> {
  const m = await ackMessage(actor, tx, messageId);
  const rows = await tx
    .select({ userId: users.id, name: users.name, email: users.email, at: messageRecipients.acknowledgedAt })
    .from(messageRecipients)
    .innerJoin(users, eq(users.id, messageRecipients.userId))
    .where(eq(messageRecipients.messageId, m.id))
    .orderBy(asc(users.name), asc(users.id));
  const acknowledged = rows.flatMap((r) => (r.at ? [{ userId: r.userId, name: r.name, email: r.email, at: r.at }] : [])).sort((x, y) => x.at.getTime() - y.at.getTime());
  const pending = rows.filter((r) => !r.at).map((r) => ({ userId: r.userId, name: r.name, email: r.email }));
  return { messageId: m.id, subject: m.subject, dueAt: m.ackDueAt, locksSignups: m.ackLocksSignups, remindedAt: m.ackRemindedAt, total: rows.length, acknowledged, pending };
}

/** The tracking list as CSV (formula-guarded), acknowledged first. The export is audited. */
export async function ackTrackingCsv(actor: Actor, tx: Tx, messageId: string): Promise<string> {
  const t = await ackTracking(actor, tx, messageId);
  const rows = [
    ...t.acknowledged.map((r) => [r.name, r.email, "Acknowledged", agencyStamp(r.at)]),
    ...t.pending.map((r) => [r.name, r.email, "Not acknowledged", ""]),
  ];
  await recordAudit(tx, { actor, action: "message.ack_export", entityType: "message", entityId: t.messageId, after: { rows: rows.length, acknowledged: t.acknowledged.length } });
  return toCsv(["Name", "Email", "Status", "Acknowledged at"], rows);
}

/** "Remind those who haven't": an alert through the normal notification path to each recipient still pending. Returns how many. */
export async function remindUnacknowledged(actor: Actor, tx: Tx, messageId: string, now: Date = new Date()): Promise<number> {
  const t = await ackTracking(actor, tx, messageId);
  if (t.pending.length === 0) return 0;
  const due = t.dueAt ? ` by ${dueDay(t.dueAt)}` : "";
  await emit(
    tx,
    {
      type: "message.ack_reminder",
      recipients: t.pending.map((p) => p.userId),
      title: `Please acknowledge: ${t.subject}`,
      body: `Read the message "${t.subject}" and press I have read and understand${due}.`,
      link: `/messages/${t.messageId}`,
    },
    now,
  );
  await tx.update(messages).set({ ackRemindedAt: now }).where(eq(messages.id, t.messageId));
  await recordAudit(tx, { actor, action: "message.ack_remind", entityType: "message", entityId: t.messageId, after: { reminded: t.pending.length } });
  return t.pending.length;
}

export type OverdueAck = { messageId: string; subject: string; dueAt: Date; acknowledged: number; total: number };

/** Messages past their due date that some recipients have not acknowledged, oldest due first, for the coordinators' To-do. */
export async function overdueAcknowledgements(tx: Tx, now: Date): Promise<OverdueAck[]> {
  const rows = await tx
    .select({
      messageId: messages.id,
      subject: messages.subject,
      dueAt: messages.ackDueAt,
      total: count(messageRecipients.id),
      acknowledged: sql<number>`count(${messageRecipients.acknowledgedAt})::int`,
    })
    .from(messages)
    .innerJoin(messageRecipients, eq(messageRecipients.messageId, messages.id))
    .where(and(eq(messages.requiresAck, true), isNotNull(messages.ackDueAt), lte(messages.ackDueAt, now)))
    .groupBy(messages.id)
    .orderBy(asc(messages.ackDueAt), asc(messages.id));
  return rows.flatMap((r) => (r.dueAt && Number(r.acknowledged) < Number(r.total) ? [{ ...r, dueAt: r.dueAt, total: Number(r.total), acknowledged: Number(r.acknowledged) }] : []));
}

export type AckLock = { locked: boolean; message: string };

/**
 * The acknowledgement sign-up lock: after the due date of a message sent with "Lock sign-ups if not acknowledged by
 * the due date", a recipient who has not acknowledged it cannot sign up, in the style of the billing lock.
 */
export async function readAckLock(tx: Tx, userId: string, now: Date): Promise<AckLock> {
  const rows = await tx
    .select({ subject: messages.subject })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .where(
      and(
        eq(messageRecipients.userId, userId),
        isNull(messageRecipients.acknowledgedAt),
        eq(messages.requiresAck, true),
        eq(messages.ackLocksSignups, true),
        lte(messages.ackDueAt, now),
      ),
    )
    .orderBy(asc(messages.ackDueAt), asc(messages.id));
  if (rows.length === 0) return { locked: false, message: "" };
  if (rows.length === 1) return { locked: true, message: `Acknowledge the message "${rows[0].subject}" to sign up again` };
  return { locked: true, message: `Acknowledge ${rows.length} messages to sign up again` };
}
