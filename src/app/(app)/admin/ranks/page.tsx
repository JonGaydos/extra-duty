import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { userDirectory } from "@/domain/admin/views";
import { listRanks } from "@/domain/ranks/ranks";
import { Notice } from "@/ui/components/Notice";
import { PageTitle } from "../../_personnel/TabLinks";
import { CountSection } from "../../coordinate/_coordinator/ui";
import { managementActor } from "../_admin/session";
import { AddRank, RankList } from "../_admin/lists";

export const metadata: Metadata = { title: "Ranks" };

/** The rank ladder, lowest first. "X and higher" on a position means this order. */
export default async function RanksPage() {
  const actor = await managementActor();
  const { ranks, users } = await withTx(async (tx) => ({ ranks: await listRanks(tx), users: await userDirectory(actor, tx) }));
  const holders = (name: string) => users.filter((u) => u.rankName === name).length;
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Lowest first. A higher rank can fill a lower rank's spot.">Ranks</PageTitle>
      <Notice tone="info">Supervisory and special roles are special flags, not ranks. A rank someone holds cannot be turned off.</Notice>
      <CountSection title="Ladder" count={ranks.filter((r) => r.active).length}>
        <RankList ranks={ranks.map((r) => ({ id: r.id, name: r.name, active: r.active, inLadder: r.inLadder, holders: holders(r.name) }))} />
      </CountSection>
      <CountSection title="Add a rank">
        <AddRank />
      </CountSection>
    </div>
  );
}
