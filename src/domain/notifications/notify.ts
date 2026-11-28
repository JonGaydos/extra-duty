import { and, eq, inArray, ne } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoices, jobs, notificationPrefs, notifications, pushSubscriptions, quietHours, users } from "@/db/schema";
import { CONFIDENTIAL_TITLE, confidentialDate, confidentialTime } from "../jobs/confidential";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE, EMAIL_QUEUE_OPTIONS, getBoss, txDb } from "@/jobs/boss";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { getSettings } from "../settings/settings";
import { agencyChannelOn, CATALOG, groupFor, type AgencyChannels, type CatalogKey, type Channel, type RecipientGroup } from "./catalog";
import { quietHoursEnd } from "./prefs";
import { alertMessageKey, type MessageKey } from "../email-messages/catalog";
import type { PlaceholderValues } from "../email-messages/placeholders";
import { renderMessage, type RenderedMessage } from "../email-messages/render";
import { loadMessage, type StoredMessage } from "../email-messages/store";
import { appLink } from "@/lib/app-link";
import { DEFAULT_CHANNELS, type NotificationEvent } from "./types";

/** A queued notification delivery (email or push). The content is encrypted at rest, like queued email. */
export type NotifyJob = { enc: string };
export type NotifyJobContent = {
  userId: string;
  notificationId: string;
  title: string;
  body: string;
  link: string;
  /** The email, rendered from the agency's email message when it was queued (email jobs only). */
  rendered?: RenderedMessage;
  sent?: string[];
};

export function decodeNotifyJob(job: NotifyJob): NotifyJobContent {
  return JSON.parse(decryptSecret(job.enc)) as NotifyJobContent;
}

/**
 * Whether the agency lets this channel of this type reach this recipient group (Management > Notifications).
 * The one check for every send: emit uses it, and so does each email sent outside it (vendorEmail).
 */
export async function agencyAllows(tx: Tx, key: CatalogKey, group: RecipientGroup, channel: Channel): Promise<boolean> {
  return agencyChannelOn((await getSettings(tx)).notificationChannels as AgencyChannels, key, group, channel);
}

/**
 * Writes an inbox row for each active recipient in the caller's transaction, and queues email and push
 * through the same transaction (a rollback sends nothing). The agency's switch for the recipient's group comes
 * first: off means no email (or push) for that group. Then each person's choice (both on when they have never
 * chosen); `mandatory` ignores choices and quiet hours. A direct message from a coordinator also ignores the
 * agency switches (spec 14: it always arrives). The inbox row is always written. Push is held until quiet hours
 * end. Vendors get no push. Users without a subscription get no push job. An in-app-only type (catalog) stops at the
 * inbox row.
 */
export async function emit(tx: Tx, event: NotificationEvent, now: Date = new Date()): Promise<void> {
  const ids = [...new Set(event.recipients)];
  if (ids.length === 0) return;
  const people = await tx.select({ id: users.id, name: users.name, email: users.email, role: users.role, active: users.active }).from(users).where(inArray(users.id, ids));
  const secret = await confidentialAbout(tx, event);
  const allowed = secret ? await mayHear(tx, secret.jobIds) : null;
  const active = people.filter((p) => p.active && (!allowed || p.role === "coordinator" || p.role === "admin" || allowed.has(p.id)));
  if (active.length === 0) return;
  const activeIds = active.map((p) => p.id);

  const rows = await tx
    .insert(notifications)
    .values(activeIds.map((userId) => ({ userId, type: event.type, title: event.title, body: event.body, link: event.link })))
    .returning({ id: notifications.id, userId: notifications.userId });
  const inboxId = new Map(rows.map((r) => [r.userId, r.id]));

  const prefs = new Map(
    (await tx.select().from(notificationPrefs).where(inArray(notificationPrefs.userId, activeIds)))
      .filter((p) => p.type === event.type)
      .map((p) => [p.userId, p]),
  );
  const quiet = new Map((await tx.select().from(quietHours).where(inArray(quietHours.userId, activeIds))).map((q) => [q.userId, q]));
  const subscribed = new Set((await tx.select({ userId: pushSubscriptions.userId }).from(pushSubscriptions).where(inArray(pushSubscriptions.userId, activeIds))).map((s) => s.userId));

  const entry = CATALOG[event.type];
  // Inbox only (a suspension notice): no email or push, whatever the agency or the person chose.
  if (entry.inAppOnly) return;
  const settings = await getSettings(tx);
  const stored = settings.notificationChannels as AgencyChannels;
  const alwaysArrives = event.mandatory === true && event.type === "message.received";
  const agencyOn = (role: (typeof active)[number]["role"], channel: Channel) => alwaysArrives || agencyChannelOn(stored, event.type, groupFor(role, entry), channel);

  const boss = await getBoss();
  // Email and push about a confidential detail carry its date (and a reminder its time) only; the inbox keeps the full alert.
  const said = pushWords(event, secret);
  const messageKey = emailMessageKey(event.type, secret !== null);
  let message: StoredMessage | undefined;
  const rendered = async (p: { name: string }) => {
    message ??= await loadMessage(tx, messageKey);
    return renderMessage(message, emailValues(event, p, settings.agency.name, secret));
  };
  const queue = async (name: string, p: { id: string }, opts: { startAfter?: Date } = {}, email: Pick<NotifyJobContent, "rendered"> = {}) => {
    const content: NotifyJobContent = { userId: p.id, notificationId: inboxId.get(p.id)!, title: said.title, body: said.body, link: event.link, ...email };
    const job: NotifyJob = { enc: encryptSecret(JSON.stringify(content)) };
    const id = await boss.send(name, job, { ...EMAIL_QUEUE_OPTIONS, ...opts, db: txDb(tx) });
    if (!id) throw new Error("The notification could not be queued.");
  };

  // Sequential: the jobs are queued in this transaction, in recipient order.
  for (const p of active) {
    const pref = prefs.get(p.id);
    if (p.email && agencyOn(p.role, "email") && (event.mandatory || (pref?.email ?? DEFAULT_CHANNELS[event.type].email))) await queue(NOTIFY_EMAIL_QUEUE, p, {}, { rendered: await rendered(p) });
    if (!pushWanted(event, p, pref, subscribed.has(p.id), agencyOn)) continue;
    const until = event.mandatory ? null : quietHoursEnd(quiet.get(p.id), now);
    await queue(NOTIFY_PUSH_QUEUE, p, until ? { startAfter: until } : {});
  }
}

/** Whether a push goes to this person: never to vendors or people with no subscription, then the agency, then their choice. */
function pushWanted<R extends string>(
  event: NotificationEvent,
  p: { role: R },
  pref: { push: boolean } | undefined,
  subscribed: boolean,
  agencyOn: (role: R, channel: Channel) => boolean,
): boolean {
  if (p.role === "vendor" || !subscribed) return false;
  if (!agencyOn(p.role, "push")) return false;
  return Boolean(event.mandatory) || (pref?.push ?? DEFAULT_CHANNELS[event.type].push);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The details an alert is about: `jobIds`, else the detail or invoice its link names. */
async function aboutJobIds(tx: Tx, event: NotificationEvent): Promise<string[]> {
  if (event.jobIds?.length) return event.jobIds;
  const [, kind, id] = /^\/(jobs|invoices)\/([^/?#]+)/.exec(event.link) ?? [];
  if (!id || !UUID.test(id)) return [];
  if (kind === "jobs") return [id];
  const rows = await tx.select({ jobId: assignments.jobId }).from(invoices).innerJoin(assignments, eq(assignments.id, invoices.assignmentId)).where(eq(invoices.id, id));
  return rows.map((r) => r.jobId);
}

/** The confidential details among those the alert is about, with the earliest start, or null when none is. */
async function confidentialAbout(tx: Tx, event: NotificationEvent): Promise<{ jobIds: string[]; startAt: Date } | null> {
  const about = await aboutJobIds(tx, event);
  if (!about.length) return null;
  const rows = await tx.select({ id: jobs.id, startAt: jobs.startAt }).from(jobs).where(and(inArray(jobs.id, about), eq(jobs.confidential, true)));
  if (!rows.length) return null;
  return { jobIds: rows.map((r) => r.id), startAt: new Date(Math.min(...rows.map((r) => r.startAt.getTime()))) };
}

/**
 * Besides coordinators and admins, who may hear about these confidential details: people who are or were on every one
 * of them (never a backup). Vendors, vendor managers and watchers are left out.
 */
async function mayHear(tx: Tx, jobIds: string[]): Promise<Set<string>> {
  const rows = await tx
    .select({ userId: assignments.userId, jobId: assignments.jobId })
    .from(assignments)
    .where(and(inArray(assignments.jobId, jobIds), ne(assignments.status, "backup")));
  const on = new Map<string, Set<string>>();
  for (const r of rows) on.set(r.userId, (on.get(r.userId) ?? new Set()).add(r.jobId));
  return new Set([...on].filter(([, jobsOn]) => jobIds.every((j) => jobsOn.has(j))).map(([userId]) => userId));
}

/**
 * The placeholder values of one person's alert email. About a confidential detail, only its date and time: the alert's
 * own words and facts are left out.
 */
function emailValues(event: NotificationEvent, p: { name: string }, agencyName: string, secret: { startAt: Date } | null): PlaceholderValues {
  const base = { "person.firstName": p.name.trim().split(/\s+/)[0] ?? "", "person.name": p.name, "agency.name": agencyName, link: appLink(event.link) ?? "" };
  if (secret) return { ...base, "detail.date": confidentialDate(secret.startAt), "detail.time": confidentialTime(secret.startAt) };
  return { ...base, "alert.title": event.title, "alert.body": event.body, ...event.vars };
}

/** An alert's email message; about a confidential detail, its confidential variant (reminder, assignment or update). */
function emailMessageKey(type: NotificationEvent["type"], confidential: boolean): MessageKey {
  if (!confidential) return alertMessageKey(type);
  if (type === "job.reminder") return "job.reminder.confidential";
  return type === "assignment.assigned" ? "confidential.assigned" : "confidential.update";
}

/** The title and text push carries: the alert's own, or about a confidential detail only its date (and a reminder's time). */
function pushWords(event: NotificationEvent, secret: { startAt: Date } | null): { title: string; body: string } {
  return secret ? confidentialWords(event, secret.startAt) : event;
}

/** What an email or push about a confidential detail says: its date (and for a reminder its time) and nothing else. */
function confidentialWords(event: NotificationEvent, startAt: Date): { title: string; body: string } {
  const day = confidentialDate(startAt);
  if (event.type === "job.reminder") {
    const time = confidentialTime(startAt);
    return { title: `Reminder: ${CONFIDENTIAL_TITLE.toLowerCase()} on ${day}`, body: `Reminder: you are assigned to a confidential detail on ${day} at ${time}. Open Signal 90 for the details.` };
  }
  const body =
    event.type === "assignment.assigned"
      ? `You were assigned to a confidential detail on ${day}. Open Signal 90 for the details.`
      : `There is an update about a confidential detail on ${day}. Open Signal 90 for the details.`;
  return { title: `${CONFIDENTIAL_TITLE} on ${day}`, body };
}
