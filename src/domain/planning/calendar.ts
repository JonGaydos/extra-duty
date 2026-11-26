import { and, asc, eq, isNotNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { calendarBusy, calendarFeeds } from "@/db/schema";
import { decryptSecret, encryptSecret } from "@/lib/crypto/secrets";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { RuleViolation, ValidationError } from "../errors";
import { CalendarFetchError, fetchCalendarText, normalizeFeedUrl } from "./calendar-fetch";
import { assertOwn, CalendarLimitError, parseIcsBusy } from "./schedule";

/** Runs a function in its own transaction. Network work happens between two of these, never inside one. */
export type TxRunner = <T>(fn: (tx: Tx) => Promise<T>) => Promise<T>;
export type SyncResult = { ok: true } | { ok: false; lastError: string };

const SYNC_WINDOW_DAYS = 90;
const SYNC_INTERVAL_MINUTES = 15;
const DAY_MS = 86_400_000;
const INSERT_CHUNK = 500;

/** Audit rows name the action and the user only; the link and event titles never reach the log. */
const audit = (tx: Tx, actor: Actor | "system", userId: string, action: string, after?: unknown) =>
  recordAudit(tx, { actor, action, entityType: "planning", entityId: userId, after });

/** Stores the link encrypted (https or webcal), or removes the link and its imported busy times when `url` is null. Fetching is a separate step. The sync limit is kept either way. */
export async function setCalendarFeed(actor: Actor, tx: Tx, url: string | null): Promise<void> {
  assertOwn(actor);
  const [existing] = await tx.select().from(calendarFeeds).where(eq(calendarFeeds.userId, actor.userId));
  const urlEnc = url === null ? null : encryptSecret(normalizeFeedUrl(url));
  if (existing) {
    await tx.delete(calendarBusy).where(eq(calendarBusy.feedId, existing.id));
    await tx.update(calendarFeeds).set({ urlEnc, lastFetchedAt: null, lastError: null }).where(eq(calendarFeeds.id, existing.id));
  } else if (urlEnc) {
    await tx.insert(calendarFeeds).values({ userId: actor.userId, urlEnc });
  }
  await audit(tx, actor, actor.userId, url === null ? "planning.calendar_feed_removed" : "planning.calendar_feed_set");
}

/** Whether a link is set and how the last fetch went. The link itself is never returned. */
export async function getCalendarFeedStatus(actor: Actor, tx: Tx, userId: string): Promise<{ connected: boolean; lastFetchedAt: Date | null; lastError: string | null }> {
  assertOwn(actor, userId);
  const [feed] = await tx.select().from(calendarFeeds).where(eq(calendarFeeds.userId, userId));
  return { connected: !!feed?.urlEnc, lastFetchedAt: feed?.lastFetchedAt ?? null, lastError: feed?.lastError ?? null };
}

export async function listCalendarBusy(actor: Actor, tx: Tx, userId: string): Promise<Array<{ startAt: Date; endAt: Date; title: string }>> {
  assertOwn(actor, userId);
  return tx
    .select({ startAt: calendarBusy.startAt, endAt: calendarBusy.endAt, title: calendarBusy.title })
    .from(calendarBusy)
    .innerJoin(calendarFeeds, eq(calendarFeeds.id, calendarBusy.feedId))
    .where(eq(calendarFeeds.userId, userId))
    .orderBy(asc(calendarBusy.startAt), asc(calendarBusy.id));
}

type Fetched = { ok: true; busy: Array<{ startAt: Date; endAt: Date; title: string }> } | { ok: false; error: string };

/**
 * Fetches and parses one feed. Runs with no transaction open. Never throws for a bad feed: the deputy gets a
 * short generic reason. Anything unexpected is logged by error name only (never the link or the calendar text).
 */
async function fetchBusy(urlEnc: string, now: Date): Promise<Fetched> {
  try {
    const text = await fetchCalendarText(decryptSecret(urlEnc));
    return { ok: true, busy: parseIcsBusy(text, now, new Date(now.getTime() + SYNC_WINDOW_DAYS * DAY_MS)) };
  } catch (err) {
    let reason: string;
    if (err instanceof CalendarFetchError) reason = err.message;
    else if (err instanceof CalendarLimitError) reason = "the calendar is too large";
    else if (err instanceof ValidationError) reason = "the file is not a valid calendar";
    else {
      console.error(`Calendar sync failed unexpectedly: ${err instanceof Error ? err.name : "unknown error"}`);
      reason = "something went wrong";
    }
    return { ok: false, error: `Could not fetch the calendar: ${reason}` };
  }
}

/**
 * Writes the outcome under the feed's row lock. On success the busy rows are replaced (in batches); on failure
 * they stay and a generic lastError is recorded. Skipped when the link changed while fetching.
 */
async function recordResult(tx: Tx, feedId: string, claimedUrlEnc: string, now: Date, result: Fetched, who: Actor | "system", userId: string): Promise<void> {
  const [feed] = await tx.select().from(calendarFeeds).where(eq(calendarFeeds.id, feedId)).for("update");
  if (feed?.urlEnc !== claimedUrlEnc) return;
  if (result.ok) {
    await tx.delete(calendarBusy).where(eq(calendarBusy.feedId, feedId));
    // Sequential: batched inserts under the feed's row lock, in this transaction.
    for (let i = 0; i < result.busy.length; i += INSERT_CHUNK) {
      await tx.insert(calendarBusy).values(result.busy.slice(i, i + INSERT_CHUNK).map((b) => ({ feedId, startAt: b.startAt, endAt: b.endAt, title: b.title })));
    }
  }
  await tx.update(calendarFeeds).set({ lastFetchedAt: now, lastError: result.ok ? null : result.error }).where(eq(calendarFeeds.id, feedId));
  await audit(tx, who, userId, "planning.calendar_sync", { ok: result.ok });
}

/**
 * "Sync now": at most once per 15 minutes per person, across link changes. Transaction 1 claims the sync under the
 * row lock (so parallel requests do one fetch); the fetch runs with no transaction open; transaction 2 records it.
 */
export async function syncCalendarNow(actor: Actor, run: TxRunner, now: Date = new Date()): Promise<SyncResult> {
  assertOwn(actor);
  const claimed = await run(async (tx) => {
    const [feed] = await tx.select().from(calendarFeeds).where(eq(calendarFeeds.userId, actor.userId)).for("update");
    if (!feed?.urlEnc) throw new ValidationError("Add a calendar link first.");
    if (feed.lastSyncRequestedAt) {
      const waitMs = feed.lastSyncRequestedAt.getTime() + SYNC_INTERVAL_MINUTES * 60_000 - now.getTime();
      if (waitMs > 0) {
        const minutes = Math.ceil(waitMs / 60_000);
        throw new RuleViolation([{ check: "planning.sync_limit", ok: false, message: `You can sync again in ${minutes} minute${minutes === 1 ? "" : "s"}` }]);
      }
    }
    await tx.update(calendarFeeds).set({ lastSyncRequestedAt: now }).where(eq(calendarFeeds.id, feed.id));
    return { id: feed.id, urlEnc: feed.urlEnc };
  });
  const result = await fetchBusy(claimed.urlEnc, now);
  await run((tx) => recordResult(tx, claimed.id, claimed.urlEnc, now, result, actor, actor.userId));
  return result.ok ? { ok: true } : { ok: false, lastError: result.error };
}

/** The daily worker's per-feed step. Returns null when the feed is gone or has no link. */
export async function syncFeedById(run: TxRunner, feedId: string, now: Date): Promise<SyncResult | null> {
  const feed = await run(async (tx) => (await tx.select().from(calendarFeeds).where(eq(calendarFeeds.id, feedId)))[0] ?? null);
  const urlEnc = feed?.urlEnc;
  if (!feed || !urlEnc) return null;
  const result = await fetchBusy(urlEnc, now);
  await run((tx) => recordResult(tx, feed.id, urlEnc, now, result, "system", feed.userId));
  return result.ok ? { ok: true } : { ok: false, lastError: result.error };
}

/** Ids of feeds that have a link, for the daily tick. */
export async function feedIdsWithLinks(tx: Tx): Promise<string[]> {
  return (await tx.select({ id: calendarFeeds.id }).from(calendarFeeds).where(and(isNotNull(calendarFeeds.urlEnc))).orderBy(asc(calendarFeeds.id))).map((r) => r.id);
}
