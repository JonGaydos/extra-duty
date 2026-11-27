import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { ladderHighestFirst, listRanks, outsideLadder, rankUsage, type Rank } from "@/domain/ranks/ranks";
import { Notice } from "@/ui/components/Notice";
import { PageTitle } from "../../_personnel/TabLinks";
import { managementActor } from "../_admin/session";
import { RankManager, type RankRow } from "./RankManager";

export const metadata: Metadata = { title: "Ranks" };

/** The rank ladder, highest first, then the ranks outside it. "X and higher" on a position means this order. */
export default async function RanksPage() {
  await managementActor();
  const rows = await withTx(async (tx) => {
    const all = await listRanks(tx);
    const row = async (r: Rank): Promise<RankRow> => {
      const u = await rankUsage(tx, r.id);
      return { id: r.id, name: r.name, active: r.active, holders: u.people, used: u.reason };
    };
    const ladder: RankRow[] = [];
    const outside: RankRow[] = [];
    // Sequential: one transaction, one connection.
    for (const r of ladderHighestFirst(all)) ladder.push(await row(r));
    for (const r of outsideLadder(all)) outside.push(await row(r));
    return { ladder, outside };
  });
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Highest first. A higher rank can fill a lower rank's spot.">Ranks</PageTitle>
      <Notice tone="info">
        The starting ranks are only defaults: rename, add and arrange them to match your agency. Supervisory and special roles are special flags, not ranks. Records are never deleted, so Delete is only for a rank added by
        mistake; a rank that has been used can be turned off once nobody holds it.
      </Notice>
      <RankManager ladder={rows.ladder} outside={rows.outside} />
    </div>
  );
}
