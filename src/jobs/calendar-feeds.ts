import { withTx } from "@/db/client";
import { feedIdsWithLinks, syncFeedById, type TxRunner } from "@/domain/planning/calendar";

/**
 * Daily: refreshes every deputy's imported calendar. Each feed is fetched with no transaction open and recorded in
 * its own short transaction, and a failure on one feed is logged (by error name only) and the loop moves on.
 */
export async function calendarFeedsTick(now: Date, run: TxRunner = withTx): Promise<{ synced: number; failed: number }> {
  const ids = await run(feedIdsWithLinks);
  let synced = 0;
  let failed = 0;
  // Sequential: one feed at a time, each in its own short transaction, so a failure is logged and skipped.
  for (const id of ids) {
    try {
      const r = await syncFeedById(run, id, now);
      if (!r) continue;
      if (r.ok) synced++;
      else failed++;
    } catch (err) {
      console.error(`Calendar feed sync failed: ${err instanceof Error ? err.name : "unknown error"}`);
      failed++;
    }
  }
  return { synced, failed };
}
