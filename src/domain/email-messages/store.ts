import { eq } from "drizzle-orm";
import type { Db, Tx } from "@/db/client";
import { emailMessages, users } from "@/db/schema";
import { getEmailSender } from "@/lib/email/sender";
import type { OutgoingEmail } from "@/lib/email/types";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors";
import { getSettings } from "../settings/settings";
import { isMessageKey, MESSAGES, MESSAGE_GROUPS, type MessageDef, type MessageKey } from "./catalog";
import { sampleValues, type PlaceholderValues } from "./placeholders";
import { messageProblem, renderMessage, type MessageText } from "./render";

/**
 * The agency's email messages (owner decision 2026-11-27): each has a built-in default, which coordinators and admins
 * may edit under Management, Reminders and locks, Email messages. Every send builds its email here, from the saved
 * message or the default. Sign-in, invite, password reset and security alert messages are admins' only.
 */

type Reader = Pick<Tx, "select"> | Pick<Db, "select">;

export type StoredMessage = MessageText & { key: MessageKey; custom: boolean; changedBy: string | null; changedAt: Date | null };

const defaultText = (def: MessageDef): MessageText => ({ subject: def.subject, body: def.body });

/** The message as it is sent now: the saved edit, or the default. */
export async function loadMessage(db: Reader, key: MessageKey): Promise<StoredMessage> {
  const def = MESSAGES[key];
  const [row] = await db
    .select({ subject: emailMessages.subject, body: emailMessages.body, changedAt: emailMessages.updatedAt, changedBy: users.name })
    .from(emailMessages)
    .leftJoin(users, eq(users.id, emailMessages.updatedBy))
    .where(eq(emailMessages.key, key));
  if (!row) return { key, ...defaultText(def), custom: false, changedBy: null, changedAt: null };
  return { key, subject: row.subject, body: row.body, custom: true, changedBy: row.changedBy, changedAt: row.changedAt };
}

/** The email for `to`, built from the message `key` with these values. */
export async function buildEmail(db: Reader, key: MessageKey, to: string | string[], values: PlaceholderValues): Promise<OutgoingEmail> {
  const r = renderMessage(await loadMessage(db, key), values);
  return { to: Array.isArray(to) ? to : [to], subject: r.subject, text: r.text, html: r.html };
}

/** Whether the actor may change this message: coordinators and admins, admins only for the admin-only ones. */
export function mayEdit(actor: Pick<Actor, "role">, def: MessageDef): boolean {
  if (def.adminOnly) return actor.role === "admin";
  return actor.role === "admin" || actor.role === "coordinator";
}

function defOf(key: string): { key: MessageKey; def: MessageDef } {
  if (!isMessageKey(key) || MESSAGES[key].hidden) throw new NotFoundError("That email message does not exist.");
  return { key, def: MESSAGES[key] };
}

function assertMayEdit(actor: Actor, def: MessageDef): void {
  assertCan(actor, "settings.notifications");
  if (!mayEdit(actor, def)) throw new ForbiddenError("Only admins can change sign-in, invitation, password reset and security emails.");
}

export type MessageListEntry = { key: MessageKey; label: string; who: string; when: string; custom: boolean; adminOnly: boolean; confidential: boolean };

/** Every listed message in its group, as the Email messages section shows them. Coordinators and admins. */
export async function listMessages(actor: Actor, tx: Tx): Promise<Array<{ group: string; messages: MessageListEntry[] }>> {
  assertCan(actor, "settings.notifications");
  const custom = new Set((await tx.select({ key: emailMessages.key }).from(emailMessages)).map((r) => r.key));
  const entries = (Object.entries(MESSAGES) as Array<[MessageKey, MessageDef]>).filter(([, d]) => !d.hidden);
  return MESSAGE_GROUPS.map((group) => ({
    group,
    messages: entries
      .filter(([, d]) => d.group === group)
      .map(([key, d]) => ({ key, label: d.label, who: d.who, when: d.when, custom: custom.has(key), adminOnly: d.adminOnly === true, confidential: d.confidential === true })),
  })).filter((g) => g.messages.length > 0);
}

/** One message for its editor: the current text, the default, and whether this actor may change it. */
export async function messageForEditor(actor: Actor, tx: Tx, key: string): Promise<{ def: MessageDef; current: StoredMessage; editable: boolean }> {
  assertCan(actor, "settings.notifications");
  const { key: k, def } = defOf(key);
  return { def, current: await loadMessage(tx, k), editable: mayEdit(actor, def) };
}

const clean = (m: MessageText): MessageText => ({ subject: m.subject.trim(), body: m.body.replaceAll("\r\n", "\n").trim() });

/** Saves an edit, after the safety checks (required and known placeholders, confidential limits). Audited with before and after. */
export async function saveMessage(actor: Actor, tx: Tx, key: string, input: MessageText): Promise<StoredMessage> {
  const { key: k, def } = defOf(key);
  assertMayEdit(actor, def);
  const next = clean({ subject: String(input.subject ?? ""), body: String(input.body ?? "") });
  const problem = messageProblem(def, next);
  if (problem) throw new ValidationError(problem);
  const before = await loadMessage(tx, k);
  const now = new Date();
  await tx
    .insert(emailMessages)
    .values({ key: k, ...next, updatedBy: actor.userId, updatedAt: now })
    .onConflictDoUpdate({ target: emailMessages.key, set: { ...next, updatedBy: actor.userId, updatedAt: now } });
  await recordAudit(tx, {
    actor,
    action: "email_message.update",
    entityType: "email_message",
    entityId: k,
    before: { subject: before.subject, body: before.body, custom: before.custom },
    after: { ...next, custom: true },
  });
  return loadMessage(tx, k);
}

/** Puts a message back to its built-in default. Audited with before and after. */
export async function resetMessage(actor: Actor, tx: Tx, key: string): Promise<StoredMessage> {
  const { key: k, def } = defOf(key);
  assertMayEdit(actor, def);
  const before = await loadMessage(tx, k);
  if (!before.custom) return before;
  await tx.delete(emailMessages).where(eq(emailMessages.key, k));
  await recordAudit(tx, {
    actor,
    action: "email_message.reset",
    entityType: "email_message",
    entityId: k,
    before: { subject: before.subject, body: before.body, custom: true },
    after: { ...defaultText(def), custom: false },
  });
  return loadMessage(tx, k);
}

/** The sample values for previews and tests, with the agency's own name. */
export async function previewValues(tx: Tx): Promise<PlaceholderValues> {
  return { ...sampleValues(), "agency.name": (await getSettings(tx)).agency.name };
}

/**
 * Send me a test: the draft (checked like a save, not saved) with sample values, to the editor's own address, through
 * the app's sender (training mode and staging keep it in the outbox). The send happens outside any transaction; the
 * audit row is written after. Returns the address. Anyone who may view the message may test it: it goes only to them.
 */
export async function sendTestMessage(actor: Actor, run: <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>, key: string, draft: MessageText): Promise<string> {
  assertCan(actor, "settings.notifications");
  const { def } = defOf(key);
  const m = clean({ subject: String(draft.subject ?? ""), body: String(draft.body ?? "") });
  const problem = messageProblem(def, m);
  if (problem) throw new ValidationError(problem);
  const { email, values } = await run(async (tx) => ({
    email: (await tx.select({ email: users.email }).from(users).where(eq(users.id, actor.userId)))[0]?.email,
    values: await previewValues(tx),
  }));
  if (!email) throw new ValidationError("Your account has no email address.");
  const r = renderMessage(m, values);
  try {
    await getEmailSender().send({ to: [email], subject: `Test: ${r.subject}`, text: r.text, html: r.html });
  } catch (e) {
    throw new ValidationError(`The test email was not sent: ${e instanceof Error ? e.message.slice(0, 300) : "unknown error"}`);
  }
  await run((tx) => recordAudit(tx, { actor, action: "email_message.test", entityType: "email_message", entityId: key, after: { to: email } }));
  return email;
}
