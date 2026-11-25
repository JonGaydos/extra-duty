import { and, count, desc, eq, isNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { notifications } from "@/db/schema";
import type { Actor } from "../actor";
import { ValidationError } from "../errors";

export type AlertRow = { id: string; type: string; title: string; body: string | null; link: string | null; at: Date; read: boolean };

export const ALERTS_PAGE_SIZE = 50;

/** The actor's own in-app alerts, newest first, 50 per page (1-based). */
export async function listAlerts(actor: Actor, tx: Tx, page = 1): Promise<AlertRow[]> {
  if (!Number.isSafeInteger(page) || page < 1) throw new ValidationError("The page must be a positive whole number.");
  const rows = await tx
    .select()
    .from(notifications)
    .where(eq(notifications.userId, actor.userId))
    .orderBy(desc(notifications.createdAt), desc(notifications.id))
    .limit(ALERTS_PAGE_SIZE)
    .offset((page - 1) * ALERTS_PAGE_SIZE);
  return rows.map((r) => ({ id: r.id, type: r.type, title: r.title, body: r.body, link: safeLink(r.link), at: r.createdAt, read: r.readAt !== null }));
}

/** How many of the actor's alerts are unread. */
export async function unreadAlertCount(actor: Actor, tx: Tx): Promise<number> {
  const [row] = await tx
    .select({ n: count() })
    .from(notifications)
    .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)));
  return Number(row?.n ?? 0);
}

/** Marks every unread alert of the actor read. */
export async function markAllAlertsRead(actor: Actor, tx: Tx, now: Date = new Date()): Promise<number> {
  const done = await tx
    .update(notifications)
    .set({ readAt: now })
    .where(and(eq(notifications.userId, actor.userId), isNull(notifications.readAt)))
    .returning({ id: notifications.id });
  return done.length;
}

/** Alert links are in-app paths; anything else is dropped so an alert can never send a person off-site. */
function safeLink(link: string | null): string | null {
  return link && /^\/(?!\/)[\w\-./?=&#%]*$/.test(link) ? link : null;
}
