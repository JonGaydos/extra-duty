import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { staffDirectory } from "@/domain/coordinator/views";
import { Icon } from "@/ui/icons";
import { EarningsView } from "../../../../billing/earnings/EarningsView";
import { coordinatorActor } from "../../../_coordinator/session";

export const metadata: Metadata = { title: "Deputy earnings" };

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Any deputy's earnings dashboard and tax summary, for coordinators and admins. */
export default async function DeputyEarningsPage({ params, searchParams }: Props) {
  const actor = await coordinatorActor();
  const { id } = await params;
  const sp = await searchParams;
  const person = (await withTx((tx) => staffDirectory(actor, tx))).find((p) => p.id === id);
  if (!person) notFound();
  return (
    <EarningsView
      actor={actor}
      userId={id}
      asked={Number(Array.isArray(sp.year) ? sp.year[0] : sp.year)}
      path={`/coordinate/reports/deputies/${id}`}
      back={
        <>
          <Link href="/coordinate/reports" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
            <Icon name="chevronLeft" size={18} />
            Back to reports
          </Link>
          <h1 className="m-0 text-2xl font-bold md:text-3xl">Earnings: {person.name}</h1>
        </>
      }
    />
  );
}
