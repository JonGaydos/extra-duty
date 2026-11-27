import { and, asc, eq, inArray, isNotNull, isNull, lte, sql } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import { jobPositions, jobs, jobWatches } from "@/db/schema";
import { endWatchAlerted, listOpenOfferJobIds, processJobOffers } from "@/domain/assignments/backups";
import { buildContext, loadPosition, heldByOffers, lockJob, signedUpCount } from "@/domain/assignments/signup";
import { withoutHiddenVendor } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";
import { evaluateSignup } from "@/domain/eligibility/eligibility";
import { getSettings } from "@/domain/settings/settings";

const inOwnTx = <T>(tx: Tx | undefined, fn: (t: Tx) => Promise<T>): Promise<T> => (tx ? fn(tx) : withTx(fn));

/**
 * Ends or advances open spot offers. A job inside the first-come window drops its offer and the spot opens
 * first come, first served; an expired sequential offer moves to the next backup; otherwise the spot reopens
 * to everyone. Each job runs in its own transaction, in job id order, unless a transaction is passed (tests).
 * Not scheduled yet.
 */
export async function backupOfferTick(now: Date, tx?: Tx): Promise<{ ended: number }> {
  const ids = await inOwnTx(tx, listOpenOfferJobIds);
  let ended = 0;
  // Sequential: one transaction per job, in job id order, so a failure leaves the earlier jobs committed.
  for (const id of ids) {
    ended += await inOwnTx(tx, async (t) => processJobOffers(t, await lockJob(t, id), now));
  }
  return { ended };
}

const RELEASE_WATCH = (now: Date) =>
  and(
    isNull(jobWatches.endedAt),
    isNotNull(jobs.releaseAt),
    lte(jobs.releaseAt, now),
    sql`${jobs.releaseAt} >= ${jobWatches.createdAt}`,
    eq(jobs.held, false),
    inArray(jobs.state, ["scheduled", "active"]),
    sql`${jobs.startAt} > ${now}`,
  );

/**
 * Alerts watchers of jobs that released after they started watching (releaseAt >= the watch's createdAt) and
 * that could take a free spot now. The marker is the watch's own endedAt: an alert ends the watch, so a watch
 * still open has not been alerted. Ineligible or restricted watchers get nothing and keep watching. Not scheduled yet.
 */
export async function watchReleaseTick(now: Date, tx?: Tx): Promise<{ alerted: number }> {
  const ids = (
    await inOwnTx(tx, (t) =>
      t.selectDistinct({ jobId: jobs.id }).from(jobWatches).innerJoin(jobs, eq(jobWatches.jobId, jobs.id)).where(RELEASE_WATCH(now)).orderBy(asc(jobs.id)),
    )
  ).map((r) => r.jobId);
  let alerted = 0;
  // Sequential: one transaction per job, in job id order, so a failure leaves the earlier jobs committed.
  for (const id of ids) {
    alerted += await inOwnTx(tx, async (t) => {
      const job = await lockJob(t, id);
      const watches = await t
        .select({ w: jobWatches })
        .from(jobWatches)
        .innerJoin(jobs, eq(jobWatches.jobId, jobs.id))
        .where(and(eq(jobWatches.jobId, id), RELEASE_WATCH(now)))
        .orderBy(asc(jobWatches.createdAt), asc(jobWatches.id));
      if (watches.length === 0) return 0;
      const settings = await getSettings(t);
      const positions = await t.select({ id: jobPositions.id }).from(jobPositions).where(eq(jobPositions.jobId, id)).orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
      const planned = { startAt: job.startAt, endAt: job.endAt };
      let n = 0;
      // A hidden vendor's release alerts are discovery alerts: skipped, and the watch stays open.
      const visible = new Set(await withoutHiddenVendor(t, watches.map(({ w }) => w.userId), job.vendorId));
      // Sequential: reads and alert writes in this transaction, in watch order.
      for (const { w } of watches) {
        if (!visible.has(w.userId)) continue;
        let eligible = false;
        // Sequential: stops at the first position the person could take.
        for (const p of positions) {
          const position = await loadPosition(t, p.id);
          const free = position.count - (await signedUpCount(t, position.id)) - (await heldByOffers(t, position.id, w.userId));
          const r = evaluateSignup(await buildContext(t, { userId: w.userId, job, position, free, planned, now, settings, includePending: true }));
          if (r.canSignUp) {
            eligible = true;
            break;
          }
        }
        if (!eligible) continue;
        await endWatchAlerted(t, w, now);
        await emit(t, { recipients: [w.userId],
          type: "job.watch_released",
          title: `Now open for sign-up: #${job.number} ${job.title}`,
          body: "A detail you are watching has been released.",
          link: `/jobs/${job.id}`,
        });
        n++;
      }
      return n;
    });
  }
  return { alerted };
}
