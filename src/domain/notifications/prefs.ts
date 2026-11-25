import { and, eq, inArray, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { notificationPrefs, notifications, pushSubscriptions, quietHours } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { ValidationError } from "../errors";
import { agencyDateParts, agencyInstant } from "../time/agency-time";
import { isNotificationType } from "./types";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

function toMinutes(hhmm: string): number {
  const m = HHMM.exec(hhmm);
  if (!m) throw new ValidationError("Use a time like 22:00.");
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Saves the actor's own email and push choice for one alert type. */
export async function setPreference(actor: Actor, tx: Tx, type: string, choice: { email: boolean; push: boolean }): Promise<void> {
  if (!isNotificationType(type)) throw new ValidationError("Unknown alert type.");
  if (typeof choice.email !== "boolean" || typeof choice.push !== "boolean") throw new ValidationError("Choose on or off for email and push.");
  const [before] = await tx
    .select()
    .from(notificationPrefs)
    .where(and(eq(notificationPrefs.userId, actor.userId), eq(notificationPrefs.type, type)));
  const [after] = await tx
    .insert(notificationPrefs)
    .values({ userId: actor.userId, type, email: choice.email, push: choice.push })
    .onConflictDoUpdate({ target: [notificationPrefs.userId, notificationPrefs.type], set: { email: choice.email, push: choice.push, updatedAt: new Date() } })
    .returning();
  await recordAudit(tx, { actor, action: "notification.setPreference", entityType: "notification_pref", entityId: after.id, before, after });
}

/** Sets the actor's daily quiet hours (agency time, may cross midnight), or turns them off with null. */
export async function setQuietHours(actor: Actor, tx: Tx, window: { start: string; end: string } | null): Promise<void> {
  if (window && toMinutes(window.start) === toMinutes(window.end)) throw new ValidationError("Quiet hours need different start and end times.");
  const [before] = await tx.select().from(quietHours).where(eq(quietHours.userId, actor.userId));
  const set = window ? { enabled: true, startTime: window.start, endTime: window.end } : { enabled: false };
  const [after] = await tx
    .insert(quietHours)
    .values({ userId: actor.userId, ...set })
    .onConflictDoUpdate({ target: quietHours.userId, set: { ...set, updatedAt: new Date() } })
    .returning();
  await recordAudit(tx, { actor, action: "notification.setQuietHours", entityType: "quiet_hours", entityId: after.id, before, after });
}

/** The instant quiet hours end if `now` falls inside the window, else null. */
export function quietHoursEnd(q: { enabled: boolean; startTime: string; endTime: string } | undefined, now: Date): Date | null {
  if (!q?.enabled) return null;
  const start = toMinutes(q.startTime);
  const end = toMinutes(q.endTime);
  const p = agencyDateParts(now);
  const at = p.hour * 60 + p.minute;
  const crosses = start > end;
  const inside = crosses ? at >= start || at < end : at >= start && at < end;
  if (!inside) return null;
  const nextDay = crosses && at >= start;
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day + (nextDay ? 1 : 0)));
  return agencyInstant(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), Math.floor(end / 60), end % 60);
}

/** Registers a browser push subscription for the actor. A known endpoint is moved to the actor (shared device). */
export async function subscribePush(actor: Actor, tx: Tx, subscription: PushSubscriptionJSON, userAgent?: string): Promise<void> {
  const { endpoint, keys } = subscription;
  if (!endpoint || !/^https:\/\//.test(endpoint)) throw new ValidationError("This push subscription is not valid.");
  if (!keys?.p256dh || !keys.auth) throw new ValidationError("This push subscription is not valid.");
  const [after] = await tx
    .insert(pushSubscriptions)
    .values({ userId: actor.userId, endpoint, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: userAgent ?? null })
    .onConflictDoUpdate({
      target: pushSubscriptions.endpoint,
      set: { userId: actor.userId, keys: { p256dh: keys.p256dh, auth: keys.auth }, userAgent: userAgent ?? null, updatedAt: new Date() },
    })
    .returning({ id: pushSubscriptions.id });
  await recordAudit(tx, { actor, action: "notification.subscribePush", entityType: "push_subscription", entityId: after.id, after: { endpointHost: new URL(endpoint).host } });
}

/** Marks the actor's own inbox rows read. Ids that are not theirs are ignored. */
export async function markRead(actor: Actor, tx: Tx, ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  if (!ids.every((id) => typeof id === "string" && UUID.test(id))) throw new ValidationError("Unknown notification.");
  await tx
    .update(notifications)
    .set({ readAt: new Date() })
    .where(and(eq(notifications.userId, actor.userId), inArray(notifications.id, ids), isNull(notifications.readAt)));
}
