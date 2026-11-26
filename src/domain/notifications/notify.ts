import { inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { notificationPrefs, notifications, pushSubscriptions, quietHours, users } from "@/db/schema";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE, EMAIL_QUEUE_OPTIONS, getBoss, txDb } from "@/jobs/boss";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import { getSettings } from "../settings/settings";
import { agencyChannelOn, CATALOG, groupFor, type AgencyChannels, type CatalogKey, type Channel, type RecipientGroup } from "./catalog";
import { quietHoursEnd } from "./prefs";
import { DEFAULT_CHANNELS, type NotificationEvent } from "./types";

/** A queued notification delivery (email or push). The content is encrypted at rest, like queued email. */
export type NotifyJob = { enc: string };
export type NotifyJobContent = { userId: string; notificationId: string; title: string; body: string; link: string; sent?: string[] };

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
  const people = await tx.select({ id: users.id, email: users.email, role: users.role, active: users.active }).from(users).where(inArray(users.id, ids));
  const active = people.filter((p) => p.active);
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
  const stored = (await getSettings(tx)).notificationChannels as AgencyChannels;
  const alwaysArrives = event.mandatory === true && event.type === "message.received";
  const agencyOn = (role: (typeof active)[number]["role"], channel: Channel) => alwaysArrives || agencyChannelOn(stored, event.type, groupFor(role, entry), channel);

  const boss = await getBoss();
  const queue = async (name: string, p: { id: string }, opts: { startAfter?: Date } = {}) => {
    const content: NotifyJobContent = { userId: p.id, notificationId: inboxId.get(p.id)!, title: event.title, body: event.body, link: event.link };
    const job: NotifyJob = { enc: encryptSecret(JSON.stringify(content)) };
    const id = await boss.send(name, job, { ...EMAIL_QUEUE_OPTIONS, ...opts, db: txDb(tx) });
    if (!id) throw new Error("The notification could not be queued.");
  };

  // Sequential: the jobs are queued in this transaction, in recipient order.
  for (const p of active) {
    const pref = prefs.get(p.id);
    if (p.email && agencyOn(p.role, "email") && (event.mandatory || (pref?.email ?? DEFAULT_CHANNELS[event.type].email))) await queue(NOTIFY_EMAIL_QUEUE, p);
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
