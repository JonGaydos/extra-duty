import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { listPositionTypes, positionTypeUsage } from "@/domain/jobs/job-types";
import { listQualifications } from "@/domain/jobs/qualifications";
import { ladderHighestFirst, listRanks, outsideLadder } from "@/domain/ranks/ranks";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { PageTitle } from "../../_personnel/TabLinks";
import { managementActor } from "../_admin/session";
import { AddPosition, PositionRowActions } from "./PositionActions";
import { dollars } from "@/ui/components/PayLabel";

export const metadata: Metadata = { title: "Position types" };

/** The spots a detail can have, who can fill each and whether vendors may ask for it. */
export default async function PositionsPage() {
  const actor = await managementActor();
  const { positions, ranks, flags, used } = await withTx(async (tx) => {
    const list = await listPositionTypes(actor, tx);
    const usage = new Map<string, string | null>();
    // Sequential: one transaction, one connection.
    for (const p of list) usage.set(p.id, (await positionTypeUsage(tx, p.id)).reason);
    const all = await listRanks(tx);
    return { positions: list, ranks: [...ladderHighestFirst(all), ...outsideLadder(all)], flags: await listQualifications(actor, tx), used: usage };
  });
  const rankName = new Map(ranks.map((r) => [r.id, r.name]));
  // Ranks are named highest first, as on the Ranks page.
  const place = new Map(ranks.map((r, i) => [r.id, i]));
  const rankOrder = (ids: string[]) => [...ids].sort((a, b) => (place.get(a) ?? 999) - (place.get(b) ?? 999));
  const flagName = new Map(flags.map((f) => [f.id, f.name]));
  const rankOptions = ranks.filter((r) => r.active).map((r) => ({ id: r.id, name: r.name }));
  const flagOptions = flags.filter((f) => f.active).map((f) => ({ id: f.id, name: f.name }));
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Each spot on a detail is one of these. The starting types are only defaults: rename, add and turn them off to fit your agency. Turned-off types stay on details that already use them; Delete is only for a type added by mistake.">Position types</PageTitle>
      <AddPosition ranks={rankOptions} flags={flagOptions} />
      <Card pad={false} as="div">
        <ul className="m-0 list-none divide-y divide-divider p-0">
          {positions.map((p) => (
            <li key={`${p.id}-${p.updatedAt?.getTime() ?? 0}`} className="flex flex-col gap-2.5 px-4 py-3.25 md:flex-row md:items-start md:justify-between md:gap-4">
              <div className="flex min-w-0 flex-col gap-1">
                <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
                  {p.name}
                  {p.vendorRequestable ? <Chip tone="info">Vendors can request</Chip> : null}
                  {p.isIncidentCommander ? <Chip tone="coordinator">Incident commander</Chip> : null}
                  {!p.active ? <Chip>Off</Chip> : null}
                </p>
                {p.rateDifferentialCents ? <p className="m-0 text-sm text-muted" data-numeric>Pays {dollars(p.rateDifferentialCents)}/hr over the detail&apos;s rate</p> : null}
                <p className="m-0 text-sm text-muted">Filled by {rankOrder(p.eligibleRankIds).map((id) => rankName.get(id) ?? "Unknown rank").join(", ")}</p>
                {used.get(p.id) ? <p className="m-0 text-sm text-muted">{used.get(p.id)}</p> : null}
                {p.requiredQualificationIds.length ? <p className="m-0 text-sm text-muted">Requires {p.requiredQualificationIds.map((id) => flagName.get(id) ?? "Unknown flag").join(", ")}</p> : null}
              </div>
              <PositionRowActions
                id={p.id}
                name={p.name}
                active={p.active}
                used={used.get(p.id) ?? null}
                ranks={rankOptions}
                flags={flagOptions}
                initial={{ name: p.name, eligibleRankIds: p.eligibleRankIds, requiredQualificationIds: p.requiredQualificationIds, isIncidentCommander: p.isIncidentCommander, vendorRequestable: p.vendorRequestable, differential: p.rateDifferentialCents ? String(p.rateDifferentialCents / 100) : "" }}
              />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
