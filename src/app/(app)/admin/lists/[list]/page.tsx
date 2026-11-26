import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { listJobTypes, listPaymentMethods, listVendorTypes } from "@/domain/jobs/job-types";
import { PageTitle } from "../../../_personnel/TabLinks";
import { CountSection } from "../../../coordinate/_coordinator/ui";
import { AddNamed, NamedList } from "../../_admin/lists";
import { managementActor } from "../../_admin/session";

const LISTS = {
  "job-types": { title: "Job types", noun: "job type", sub: "The kind of work a detail is, such as traffic or security.", load: listJobTypes },
  "vendor-types": { title: "Vendor types", noun: "vendor type", sub: "Groups vendors for reports, such as school or church.", load: listVendorTypes },
  "payment-methods": { title: "Payment methods", noun: "payment method", sub: "How vendors may say they paid a deputy.", load: listPaymentMethods },
} as const;

type Props = { params: Promise<{ list: string }> };

const listOf = (slug: string) => (slug in LISTS ? { slug, ...LISTS[slug as keyof typeof LISTS] } : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  return { title: listOf((await params).list)?.title ?? "Lists" };
}

/** A simple named list: add, rename, turn off and on. Nothing is deleted, because records use these names. */
export default async function NamedListPage({ params }: Readonly<Props>) {
  const actor = await managementActor();
  const l = listOf((await params).list);
  if (!l) notFound();
  const items = await withTx((tx) => l.load(actor, tx));
  return (
    <div className="flex flex-col gap-4.5">
      <p className="m-0 text-sm">
        <Link href="/admin">Management</Link>
      </p>
      <PageTitle sub={l.sub}>{l.title}</PageTitle>
      <CountSection title="In use" count={items.filter((i) => i.active).length}>
        <NamedList list={l.slug} noun={l.noun} items={items.map((i) => ({ id: i.id, name: i.name, active: i.active }))} />
      </CountSection>
      <CountSection title={`Add a ${l.noun}`}>
        <AddNamed list={l.slug} noun={l.noun} />
      </CountSection>
    </div>
  );
}
