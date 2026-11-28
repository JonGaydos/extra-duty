import { withTx } from "@/ui/shell/request";
import type { Actor } from "@/domain/actor";
import { claimablePositionId } from "@/domain/assignments/backups";
import { eligibilityByPosition, type JobEligibility } from "@/domain/assignments/signup";
import { deputyNotesForJob } from "@/domain/deputy-notes/deputy-notes";
import { NotFoundError } from "@/domain/errors";
import { openJob } from "@/domain/jobs/jobs";
import { getJobOpsPlan } from "@/domain/ops-plans/ops-plans";
import { capSummary, jobActivity, jobRoster, loadJobCards, myDetails } from "@/domain/personnel/views";
import { getSettings } from "@/domain/settings/settings";

/** Everything the deputy's detail page shows, in one transaction; null when there is no such detail. */
export async function loadJobPage(actor: Actor, id: string, now: Date) {
  return withTx(async (tx) => {
    let job;
    try {
      // Every open of a confidential detail is logged.
      job = await openJob(actor, tx, id);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
    const [card] = await loadJobCards(actor, tx, [job], now);
    let eligibility: JobEligibility[] = [];
    try {
      eligibility = await eligibilityByPosition(actor, tx, id, now);
    } catch (e) {
      if (!(e instanceof NotFoundError)) throw e;
    }
    const caps = await capSummary(actor, tx, now);
    const settings = await getSettings(tx);
    // One row per detail: the live sign-up when there is one, else the last one that ended (taken over, removed).
    const own = (await myDetails(actor, tx, now)).find((d) => d.job.id === id) ?? null;
    const gone = own !== null && ["canceled", "removed"].includes(own.status);
    const mine = gone ? null : own;
    return {
      ended: gone ? { status: own.status, reason: own.reason } : null,
      claimPositionId: mine?.status === "backup" ? await claimablePositionId(tx, mine.assignmentId, now) : null,
      job,
      card,
      eligibility,
      caps,
      settings,
      mine,
      roster: await jobRoster(actor, tx, id),
      activity: await jobActivity(actor, tx, id),
      notes: await deputyNotesForJob(actor, tx, id),
      ops: job.opsPlanRequired ? await getJobOpsPlan(actor, tx, id) : null,
    };
  });
}

export type JobPageData = NonNullable<Awaited<ReturnType<typeof loadJobPage>>>;
