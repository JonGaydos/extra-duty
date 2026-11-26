import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { vendorDirectory } from "@/domain/coordinator/views";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { Input } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import { PageTitle, TabLinks } from "../../_personnel/TabLinks";
import { plural } from "../../_personnel/format";
import { coordinatorActor } from "../_coordinator/session";
import { Row, Rows } from "../_coordinator/ui";
import { NewVendor } from "./VendorActions";

export const metadata: Metadata = { title: "Vendors" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
type Show = "active" | "hold" | "inactive";
type DirectoryVendor = Awaited<ReturnType<typeof vendorDirectory>>[number];

const IN_LIST: Record<Show, (v: DirectoryVendor) => boolean> = {
  active: (v) => v.active,
  hold: (v) => v.paymentHold,
  inactive: (v) => !v.active,
};

const contactLead = (v: DirectoryVendor) => (v.contactName ? `${v.contactName}. ` : "");

/** Payment hold, or Inactive for a vendor in good standing that is turned off. */
function VendorChip({ v }: Readonly<{ v: DirectoryVendor }>) {
  return v.paymentHold ? <Chip tone="danger">Payment hold</Chip> : <Chip>Inactive</Chip>;
}

/** Every vendor, active first, with holds and upcoming detail counts; add a vendor. */
export default async function VendorsPage({ searchParams }: Readonly<Props>) {
  const actor = await coordinatorActor();
  const sp = await searchParams;
  const q = typeof sp.q === "string" ? sp.q.trim().toLowerCase() : "";
  const show: Show = sp.show === "inactive" || sp.show === "hold" ? sp.show : "active";
  const all = await withTx((tx) => vendorDirectory(actor, tx));
  const list = all.filter(IN_LIST[show]).filter((v) => !q || v.name.toLowerCase().includes(q));
  const search = q ? `&q=${encodeURIComponent(q)}` : "";
  const href = (s: string) => `/coordinate/vendors?show=${s}${search}`;

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle>Vendors</PageTitle>
      <NewVendor />
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <TabLinks
          label="Which vendors"
          current={show}
          items={[
            { key: "active", label: `Active ${all.filter((v) => v.active).length}`, href: href("active") },
            { key: "hold", label: `On hold ${all.filter((v) => v.paymentHold).length}`, href: href("hold") },
            { key: "inactive", label: `Inactive ${all.filter((v) => !v.active).length}`, href: href("inactive") },
          ]}
        />
        <form role="search" action="/coordinate/vendors" className="flex gap-2">
          <input type="hidden" name="show" value={show} />
          <Input name="q" defaultValue={q} aria-label="Search vendors" placeholder="Vendor name" className="md:w-64" />
          <button type="submit" className="flex size-11 shrink-0 items-center justify-center rounded-sm border border-line bg-surface hover:bg-subtle" aria-label="Search">
            <Icon name="search" size={20} />
          </button>
        </form>
      </div>
      {list.length === 0 ? (
        <Card pad={false}>
          <EmptyState title="No vendors here">{q ? "Nothing matches that name." : "Vendors you add show up here."}</EmptyState>
        </Card>
      ) : (
        <Rows>
          {list.map((v) => (
            <Row
              key={v.id}
              title={v.name}
              href={`/coordinate/vendors/${v.id}`}
              meta={`${contactLead(v)}${plural(v.upcoming, "upcoming detail")}`}
              actions={v.paymentHold || !v.active ? <VendorChip v={v} /> : null}
            />
          ))}
        </Rows>
      )}
    </div>
  );
}
