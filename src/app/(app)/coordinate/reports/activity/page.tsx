import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { listSeasons } from "@/domain/caps/seasons";
import { listQualifications } from "@/domain/jobs/qualifications";
import { listRanks } from "@/domain/ranks/ranks";
import { labelFor } from "@/domain/reports/engine";
import { activityPeriods } from "@/domain/reports/periods";
import { ACTIVITY_MEASURES, listSavedReports } from "@/domain/reports/saved";
import { Icon } from "@/ui/icons";
import { PageTitle } from "../../../_personnel/TabLinks";
import { coordinatorActor } from "../../_coordinator/session";
import { ActivityReport, type SavedActivity } from "./ActivityReport";

export const metadata: Metadata = { title: "Personnel activity" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Who worked, who signed up and who canceled, one row per person, for coordinators and admins. */
export default async function ActivityReportPage({ searchParams }: Props) {
  const actor = await coordinatorActor();
  const sp = await searchParams;
  const savedId = Array.isArray(sp.saved) ? sp.saved[0] : sp.saved;
  const now = new Date();
  const data = await withTx(async (tx) => ({
    ranks: (await listRanks(tx)).filter((r) => r.active),
    flags: (await listQualifications(actor, tx)).filter((q) => q.active),
    seasons: await listSeasons(actor, tx),
    saved: savedId ? (await listSavedReports(actor, tx)).find((r) => r.id === savedId && (r.spec as { dataset?: string }).dataset === "activity") : undefined,
  }));
  const periods = activityPeriods(now, data.seasons);
  const saved: SavedActivity | null = data.saved ? { name: data.saved.name, spec: data.saved.spec as SavedActivity["spec"] } : null;
  const labels = Object.fromEntries(["deputy", ...ACTIVITY_MEASURES].map((c) => [c, labelFor("activity", c as never)]));

  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/coordinate/reports" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to reports
      </Link>
      <PageTitle sub="Details worked, sign-ups and cancellations for each person. Dates are in Central time.">Personnel activity</PageTitle>
      <ActivityReport
        measures={[...ACTIVITY_MEASURES]}
        labels={labels}
        periods={periods}
        ranks={data.ranks.map((r) => ({ id: r.id, name: r.name }))}
        flags={data.flags.map((q) => ({ id: q.id, name: q.name }))}
        saved={saved}
      />
    </div>
  );
}
