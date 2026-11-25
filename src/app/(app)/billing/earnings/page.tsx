import type { Metadata } from "next";
import Link from "next/link";
import { Icon } from "@/ui/icons";
import { personnelActor } from "../../_personnel/session";
import { EarningsView } from "./EarningsView";

export const metadata: Metadata = { title: "Earnings" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** The person's own earnings and tax summary. */
export default async function EarningsPage({ searchParams }: Props) {
  const actor = await personnelActor();
  const sp = await searchParams;
  return (
    <EarningsView
      actor={actor}
      userId={actor.userId}
      asked={Number(Array.isArray(sp.year) ? sp.year[0] : sp.year)}
      path="/billing/earnings"
      back={
        <>
          <Link href="/billing" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
            <Icon name="chevronLeft" size={18} />
            Back to billing
          </Link>
          <h1 className="m-0 text-2xl font-bold md:text-3xl">Earnings</h1>
        </>
      }
    />
  );
}
