import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { listSeasons } from "@/domain/caps/seasons";
import { getSettings } from "@/domain/settings/settings";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { PageTitle } from "../../_personnel/TabLinks";
import { managementActor } from "../_admin/session";
import { AddSeason, SeasonCard } from "./SeasonCard";

export const metadata: Metadata = { title: "Seasons and caps" };

/** Hour caps by season. Seasons may not overlap; dates no season covers have no caps. */
export default async function SeasonsPage() {
  const actor = await managementActor();
  const { seasons, settings } = await withTx(async (tx) => ({ seasons: await listSeasons(actor, tx), settings: await getSettings(tx) }));
  const rolling = settings.rollingCapWindowHours;
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="The most hours one person may work on details. Seasons cannot overlap.">Seasons and caps</PageTitle>
      <AddSeason rollingHours={rolling} />
      {seasons.length ? (
        <div className="grid items-start gap-4.5 md:grid-cols-2">
          {seasons.map((s) => (
            <SeasonCard
              key={`${s.id}-${s.updatedAt?.getTime() ?? 0}`}
              rollingHours={rolling}
              season={{ id: s.id, name: s.name, start: s.startMonthDay, end: s.endMonthDay, rolling: s.rollingCapMinutes, week: s.weekCapMinutes, month: s.monthCapMinutes }}
            />
          ))}
        </div>
      ) : (
        <Card pad={false}>
          <EmptyState title="No seasons">Without a season, nobody has an hour cap. Add one that covers the whole year.</EmptyState>
        </Card>
      )}
    </div>
  );
}
