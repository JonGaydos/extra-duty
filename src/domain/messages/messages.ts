import { and, asc, count, desc, eq, exists, gt, ilike, inArray, isNull, ne, notInArray, or, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, jobs, messageRecipients, messages, spotOffers, users, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { coordinatorAudience, jobAudience } from "../notifications/audiences";
import { emit } from "../notifications/notify";
import { getSettings } from "../settings/settings";

export type Audience =
  | { kind: "all" }
  | { kind: "users"; userIds: string[] }
  | { kind: "rank"; rankIds: string[] }
  | { kind: "job"; jobId: string }
  | { kind: "coordinators" };

export type Message = typeof messages.$inferSelect;
export type SendInput = { audiences: Audience[]; subject: string; body: string; jobId?: string; replyToMessageId?: string };

export const MESSAGE_PAGE_SIZE = 25;
const SNIPPET_LENGTH = 140;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function checkIds(ids: unknown, label: string): string[] {
  if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && UUID.test(id))) throw new ValidationError(`${label} is not valid.`);
  return ids as string[];
}

function snippet(body: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}

const isCoordinator = (a: Actor) => a.role === "coordinator" || a.role === "admin";

/** Refuses "all" unless the actor may message everyone. */
async function assertMayMessageAll(actor: Actor, tx: Tx): Promise<void> {
  assertCan(actor, "message.sendAll");
  if (!isCoordinator(actor) && !(await getSettings(tx)).personnelCanMessageAll) {
    throw new ForbiddenError("Messaging all users is turned off.");
  }
}

async function namedUsers(tx: Tx, userIds: unknown): Promise<string[]> {
  const named = checkIds(userIds, "A recipient");
  const found = named.length ? await tx.select({ id: users.id, role: users.role }).from(users).where(inArray(users.id, named)) : [];
  if (found.length !== new Set(named).size || found.some((u) => u.role === "vendor")) throw new ValidationError("One or more recipients cannot be messaged.");
  return named;
}

async function rankUsers(tx: Tx, ids: unknown): Promise<string[]> {
  const rankIds = checkIds(ids, "A rank");
  const rows = rankIds.length ? await tx.select({ id: users.id }).from(users).where(inArray(users.rankId, rankIds)) : [];
  return rows.map((r) => r.id);
}

/** A detail's roster: staff for any detail, a deputy only for one they may link (the About a detail rule). */
async function jobUsers(actor: Actor, tx: Tx, jobId: unknown, now: Date): Promise<Iterable<string>> {
  if (typeof jobId !== "string" || !UUID.test(jobId)) throw new NotFoundError("Job not found.");
  const [job] = await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId));
  if (!job) throw new NotFoundError("Job not found.");
  if (!isCoordinator(actor) && (await linkableDetails(actor, tx, now, job.id)).length === 0) {
    throw new ForbiddenError("You can message the roster only of a detail that has not ended and that you are signed up for, pending on or offered.");
  }
  return jobAudience(tx, job);
}

/** One audience's candidate user ids, or "everyone". */
async function audienceIds(actor: Actor, tx: Tx, a: Audience, now: Date): Promise<Iterable<string> | "everyone"> {
  switch (a.kind) {
    case "all":
      await assertMayMessageAll(actor, tx);
      return "everyone";
    case "users":
      return namedUsers(tx, a.userIds);
    case "rank":
      return rankUsers(tx, a.rankIds);
    case "job":
      return jobUsers(actor, tx, a.jobId, now);
    case "coordinators":
      return coordinatorAudience(tx);
    default:
      throw new ValidationError("Unknown audience.");
  }
}

/** Resolves the audiences to candidate user ids. Validates everything it is given before any write. */
async function resolve(actor: Actor, tx: Tx, audiences: Audience[], now: Date): Promise<{ ids: string[]; everyone: boolean }> {
  const ids = new Set<string>();
  let everyone = false;
  // Sequential: each audience is checked in order in this transaction, so the first refusal is the one reported.
  for (const a of audiences) {
    const found = await audienceIds(actor, tx, a, now);
    if (found === "everyone") everyone = true;
    else for (const id of found) ids.add(id);
  }
  return { ids: [...ids], everyone };
}

/** The trimmed subject and body, after the length and audience checks. */
function checkSendInput(input: SendInput): { subject: string; body: string } {
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (subject.length < 1 || subject.length > 200) throw new ValidationError("The subject must be 1 to 200 characters.");
  if (body.length < 1 || body.length > 10_000) throw new ValidationError("The message must be 1 to 10,000 characters.");
  const audiences = input.audiences;
  if (!Array.isArray(audiences) || audiences.some((a) => typeof a !== "object" || !a)) throw new ValidationError("Choose who to send this to.");
  if (audiences.length === 0 && input.replyToMessageId === undefined) throw new ValidationError("Choose who to send this to.");
  return { subject, body };
}

async function assertJobExists(tx: Tx, jobId: unknown): Promise<void> {
  if (typeof jobId !== "string" || !UUID.test(jobId) || !(await tx.select({ id: jobs.id }).from(jobs).where(eq(jobs.id, jobId)))[0]) {
    throw new NotFoundError("Job not found.");
  }
}

export type LinkableDetail = { id: string; number: number; vendorName: string; startAt: Date };

/**
 * The details a message may be "About" (owner decision 2026-11-27). Never one that has ended. Staff may link any other
 * (not canceled or declined). A deputy only one they are signed up for, waiting on a shorter shift for, or offered a
 * spot on as a backup; so a detail they cannot see (confidential to its people) is never offered to them.
 */
export async function linkableDetails(actor: Actor, tx: Tx, now: Date = new Date(), onlyJobId?: string): Promise<LinkableDetail[]> {
  assertCan(actor, "message.send");
  const live = and(gt(jobs.endAt, now), notInArray(jobs.state, ["canceled", "declined"]), onlyJobId ? eq(jobs.id, onlyJobId) : undefined);
  const cols = { id: jobs.id, number: jobs.number, vendorName: vendors.name, startAt: jobs.startAt };
  if (isCoordinator(actor)) {
    return tx.select(cols).from(jobs).innerJoin(vendors, eq(vendors.id, jobs.vendorId)).where(live).orderBy(asc(jobs.startAt), asc(jobs.number));
  }
  const offered = exists(
    tx
      .select({ x: spotOffers.id })
      .from(spotOffers)
      .where(and(eq(spotOffers.status, "open"), or(eq(spotOffers.offeredToAssignmentId, assignments.id), and(eq(spotOffers.mode, "all_backups"), eq(spotOffers.jobPositionId, assignments.jobPositionId))))),
  );
  const mine = or(inArray(assignments.status, ["signed_up", "pending_short"]), and(eq(assignments.status, "backup"), offered));
  return tx
    .selectDistinct(cols)
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(and(eq(assignments.userId, actor.userId), mine, live))
    .orderBy(asc(jobs.startAt), asc(jobs.number));
}

/** Refuses an "About a detail" link the actor may not make: an unknown detail, an ended one, or (for a deputy) not theirs. */
async function assertMayLink(actor: Actor, tx: Tx, jobId: unknown, now: Date): Promise<void> {
  await assertJobExists(tx, jobId);
  if ((await linkableDetails(actor, tx, now, jobId as string)).length === 0) {
    throw new ForbiddenError("You can link only a detail that has not ended and that you are signed up for, pending on or offered.");
  }
}

/** Who a reply also goes to: the original recipients when the sender replies, else the original sender. */
async function replyRecipients(actor: Actor, tx: Tx, replyToMessageId: unknown): Promise<string[]> {
  if (typeof replyToMessageId !== "string" || !UUID.test(replyToMessageId)) throw new NotFoundError("Message not found.");
  const [orig] = await tx.select().from(messages).where(eq(messages.id, replyToMessageId));
  if (!orig) throw new NotFoundError("Message not found.");
  const [mine] = await tx
    .select({ id: messageRecipients.id })
    .from(messageRecipients)
    .where(and(eq(messageRecipients.messageId, orig.id), eq(messageRecipients.userId, actor.userId)));
  if (orig.senderUserId !== actor.userId && !mine) throw new ForbiddenError("Only the sender or a recipient can reply.");
  if (orig.senderUserId === actor.userId) {
    const all = await tx.select({ userId: messageRecipients.userId }).from(messageRecipients).where(eq(messageRecipients.messageId, orig.id));
    return all.map((r) => r.userId);
  }
  return orig.senderUserId ? [orig.senderUserId] : [];
}

/** The active, non-vendor users among the candidates (everyone when `everyone`), never the sender. */
async function liveRecipients(actor: Actor, tx: Tx, ids: string[], everyone: boolean): Promise<string[]> {
  const live = and(eq(users.active, true), ne(users.role, "vendor"), ne(users.id, actor.userId));
  let rows: Array<{ id: string }> = [];
  if (everyone) rows = await tx.select({ id: users.id }).from(users).where(live);
  else if (ids.length) rows = await tx.select({ id: users.id }).from(users).where(and(live, inArray(users.id, ids)));
  return [...new Set(rows.map((r) => r.id))];
}

/**
 * Sends an in-app message. Recipients are the de-duplicated union of the audiences, minus the sender, and
 * never inactive or vendor users. A reply also goes to the original sender. Coordinator and admin messages
 * are mandatory alerts (they ignore alert choices).
 */
export async function sendMessage(actor: Actor, tx: Tx, input: SendInput, now: Date = new Date()): Promise<Message> {
  assertCan(actor, "message.send");
  checkSendInput(input);
  if (input.jobId !== undefined) await assertMayLink(actor, tx, input.jobId, now);
  return deliver(actor, tx, input, now);
}

/** Sends after the caller has checked the detail link. */
async function deliver(actor: Actor, tx: Tx, input: SendInput, now: Date = new Date()): Promise<Message> {
  const { subject, body } = checkSendInput(input);
  const audiences = input.audiences;

  const { ids, everyone } = await resolve(actor, tx, audiences, now);
  if (input.replyToMessageId !== undefined) {
    for (const id of await replyRecipients(actor, tx, input.replyToMessageId)) ids.push(id);
  }

  const recipientIds = await liveRecipients(actor, tx, ids, everyone);
  if (recipientIds.length === 0) throw new ValidationError("There is no one to send this message to.");

  const [message] = await tx
    .insert(messages)
    .values({
      senderUserId: actor.userId,
      subject,
      body,
      recipientCount: recipientIds.length,
      jobId: input.jobId ?? null,
      replyToMessageId: input.replyToMessageId ?? null,
    })
    .returning();
  await tx.insert(messageRecipients).values(recipientIds.map((userId) => ({ messageId: message.id, userId })));
  await emit(tx, {
    type: "message.received",
    recipients: recipientIds,
    title: subject,
    body,
    link: `/messages/${message.id}`,
    mandatory: isCoordinator(actor),
  });
  await recordAudit(tx, {
    actor,
    action: "message.send",
    entityType: "message",
    entityId: message.id,
    after: { audiences: [...new Set(audiences.map((a) => a.kind))], recipientCount: recipientIds.length },
  });
  return message;
}

/** Asks the coordinators a question about a job. */
export async function messageCoordinators(actor: Actor, tx: Tx, input: { jobId: string; body: string }): Promise<Message> {
  assertCan(actor, "message.send");
  const [job] =
    typeof input.jobId === "string" && UUID.test(input.jobId)
      ? await tx.select({ id: jobs.id, number: jobs.number, title: jobs.title }).from(jobs).where(eq(jobs.id, input.jobId))
      : [];
  if (!job) throw new NotFoundError("Job not found.");
  const prefix = `Question about Detail #${job.number}: `;
  // A question from the detail's own page: any detail the person can open, so the link is not the compose page's rule.
  return deliver(actor, tx, {
    audiences: [{ kind: "coordinators" }],
    subject: Array.from(`${prefix}${job.title}`).slice(0, 200).join(""),
    body: input.body,
    jobId: job.id,
  });
}

export type InboxRow = { messageId: string; senderName: string | null; subject: string; snippet: string; sentAt: Date; read: boolean; jobId: string | null };
export type SentRow = { messageId: string; subject: string; snippet: string; sentAt: Date; recipientCount: number; jobId: string | null };

function pageOffset(page: number): number {
  if (!Number.isSafeInteger(page) || page < 1) throw new ValidationError("The page must be a positive whole number.");
  return (page - 1) * MESSAGE_PAGE_SIZE;
}

/** The actor's own non-hidden messages, newest first, 25 per page (page is 1-based). */
export async function listInbox(actor: Actor, tx: Tx, filter: { text?: string; unreadOnly?: boolean; page: number }): Promise<InboxRow[]> {
  assertCan(actor, "message.send");
  const conds: SQL[] = [eq(messageRecipients.userId, actor.userId), isNull(messageRecipients.hiddenAt)];
  if (filter.unreadOnly) conds.push(isNull(messageRecipients.readAt));
  const text = filter.text?.trim().slice(0, 200);
  if (text) {
    const like = `%${text.replace(/[\\%_]/g, "\\$&")}%`;
    conds.push(or(ilike(messages.subject, like), ilike(messages.body, like))!);
  }
  const rows = await tx
    .select({
      messageId: messages.id,
      senderName: users.name,
      subject: messages.subject,
      body: messages.body,
      sentAt: messages.sentAt,
      readAt: messageRecipients.readAt,
      jobId: messages.jobId,
    })
    .from(messageRecipients)
    .innerJoin(messages, eq(messages.id, messageRecipients.messageId))
    .leftJoin(users, eq(users.id, messages.senderUserId))
    .where(and(...conds))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(MESSAGE_PAGE_SIZE)
    .offset(pageOffset(filter.page));
  return rows.map((r) => ({ messageId: r.messageId, senderName: r.senderName, subject: r.subject, snippet: snippet(r.body), sentAt: r.sentAt, read: r.readAt !== null, jobId: r.jobId }));
}

/** Messages the actor sent, newest first, 25 per page. */
export async function listSent(actor: Actor, tx: Tx, filter: { page: number }): Promise<SentRow[]> {
  assertCan(actor, "message.send");
  const rows = await tx
    .select()
    .from(messages)
    .where(eq(messages.senderUserId, actor.userId))
    .orderBy(desc(messages.sentAt), desc(messages.id))
    .limit(MESSAGE_PAGE_SIZE)
    .offset(pageOffset(filter.page));
  return rows.map((r) => ({ messageId: r.id, subject: r.subject, snippet: snippet(r.body), sentAt: r.sentAt, recipientCount: r.recipientCount, jobId: r.jobId }));
}

/** One message in full, for its sender or a recipient (hidden or not). */
export async function getMessage(actor: Actor, tx: Tx, id: string): Promise<Message> {
  assertCan(actor, "message.send");
  if (typeof id !== "string" || !UUID.test(id)) throw new NotFoundError("Message not found.");
  const [m] = await tx.select().from(messages).where(eq(messages.id, id));
  if (!m) throw new NotFoundError("Message not found.");
  if (m.senderUserId !== actor.userId) {
    const [mine] = await tx
      .select({ id: messageRecipients.id })
      .from(messageRecipients)
      .where(and(eq(messageRecipients.messageId, id), eq(messageRecipients.userId, actor.userId)));
    if (!mine) throw new NotFoundError("Message not found.");
  }
  return m;
}

/** Marks the actor's own copies read or unread. Other people's copies are never touched. */
export async function markRead(actor: Actor, tx: Tx, ids: string[], read: boolean): Promise<void> {
  assertCan(actor, "message.send");
  const list = checkIds(ids, "A message");
  if (list.length === 0) return;
  await tx
    .update(messageRecipients)
    .set({ readAt: read ? new Date() : null })
    .where(and(eq(messageRecipients.userId, actor.userId), inArray(messageRecipients.messageId, list)));
}

/** Removes messages from the actor's own inbox. The message, its other recipients and the sender's Sent list keep it. */
export async function hideMessages(actor: Actor, tx: Tx, ids: string[]): Promise<void> {
  assertCan(actor, "message.send");
  const list = checkIds(ids, "A message");
  if (list.length === 0) return;
  const hidden = await tx
    .update(messageRecipients)
    .set({ hiddenAt: new Date() })
    .where(and(eq(messageRecipients.userId, actor.userId), inArray(messageRecipients.messageId, list), isNull(messageRecipients.hiddenAt)))
    .returning({ messageId: messageRecipients.messageId });
  // Sequential: audit writes in this transaction.
  for (const h of hidden) {
    await recordAudit(tx, { actor, action: "message.hide", entityType: "message", entityId: h.messageId });
  }
}

/** How many of the actor's own (not hidden) messages are unread. */
export async function unreadMessageCount(actor: Actor, tx: Tx): Promise<number> {
  assertCan(actor, "message.send");
  const [row] = await tx
    .select({ n: count() })
    .from(messageRecipients)
    .where(and(eq(messageRecipients.userId, actor.userId), isNull(messageRecipients.readAt), isNull(messageRecipients.hiddenAt)));
  return Number(row?.n ?? 0);
}
