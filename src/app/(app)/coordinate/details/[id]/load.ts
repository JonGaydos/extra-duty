import { withTx } from "@/ui/shell/request";
import type { Actor } from "@/domain/actor";
import { detailFormOptions, jobAdmin, rateOverrideOf, staffDirectory } from "@/domain/coordinator/views";
import { deputyNotesForJob } from "@/domain/deputy-notes/deputy-notes";
import { NotFoundError } from "@/domain/errors";
import { loadJobStatus } from "@/domain/jobs/status";
import { getJob, reactivationPreview } from "@/domain/jobs/jobs";
import { eligibleReviewers, getJobOpsPlan } from "@/domain/ops-plans/ops-plans";
import { jobActivity } from "@/domain/personnel/views";
import { getSettings } from "@/domain/settings/settings";
import { outsideRange } from "@/domain/jobs/rate";

/** Everything the coordinator's detail page shows, in one transaction; null when there is no such detail. */
export async function loadDetail(actor: Actor, id: string, now: Date) {
  return withTx(async (tx) => {
    let job;
    try {
      job = await getJob(actor, tx, id);
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
    const admin = await jobAdmin(actor, tx, id);
    const ops = job.opsPlanRequired ? await getJobOpsPlan(actor, tx, id) : null;
    const latest = ops?.versions.at(-1);
    const settings = await getSettings(tx);
    const canReview =
      !!ops?.opsPlanId && !!latest && latest.decision === "pending" && settings.opsPlanReviewerUserIds.includes(actor.userId) && (await eligibleReviewers(tx, id, latest.submittedBy)).includes(actor.userId);
    const people = await staffDirectory(actor, tx);
    return {
      job,
      admin,
      ops,
      canReview,
      people: people.filter((p) => p.role !== "vendor"),
      notes: await deputyNotesForJob(actor, tx, id),
      activity: await jobActivity(actor, tx, id, 20),
      options: await detailFormOptions(actor, tx, now),
      rateOverride: await rateOverrideOf(tx, job),
      rateOutside: outsideRange(job.rateCents, settings),
      agencyWait: settings.waitForAllDeputies,
      // A canceled detail can come back until it ends.
      reactivation: job.state === "canceled" && now.getTime() < job.endAt.getTime() ? await reactivationPreview(actor, tx, id) : null,
      status: await loadJobStatus(tx, id, now),
    };
  });
}

export type DetailData = NonNullable<Awaited<ReturnType<typeof loadDetail>>>;
