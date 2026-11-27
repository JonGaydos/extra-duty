import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { managerOverview, type ManagedDetailRow } from "@/domain/vendors/managers";
import { ActionLink, ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { Icon } from "@/ui/icons";
import { whenText } from "../_personnel/format";
import { PageTitle } from "../_personnel/TabLinks";
import { CountSection, Row, Rows } from "../coordinate/_coordinator/ui";
import { vendorManagerActor } from "./session";

export const metadata: Metadata = { title: "Manage" };

/** Where the detail stands: held, not released yet, a change the vendor asked for, and how full it is. */
function DetailChips({ d, now }: Readonly<{ d: ManagedDetailRow; now: Date }>) {
  const open = d.needed - d.filled;
  return (
    <span className="flex flex-wrap gap-1.5">
      {d.state === "requested" ? <Chip tone="warning">Vendor request</Chip> : null}
      {d.state !== "requested" && open > 0 ? <Chip tone="attention">{open} open</Chip> : null}
      {d.state !== "requested" && open <= 0 ? <Chip>Filled</Chip> : null}
      {d.held ? <Chip tone="warning">Held</Chip> : null}
      {d.pendingChanges > 0 ? <Chip tone="warning">Change requested</Chip> : null}
      {d.startAt.getTime() <= now.getTime() ? <Chip>Started</Chip> : null}
    </span>
  );
}

function DetailRow({ d, now }: Readonly<{ d: ManagedDetailRow; now: Date }>) {
  const where = d.locationName ? `, ${d.locationName}` : "";
  return (
    <Row
      title={`#${d.number} ${d.title}`}
      href={`/jobs/${d.number}?tab=manage`}
      meta={
        <span className="flex flex-col gap-1.5">
          <span>
            {whenText(d.startAt, d.endAt, now)}
            {where}. {d.filled} of {d.needed} filled.
          </span>
          <DetailChips d={d} now={now} />
        </span>
      }
    />
  );
}

/**
 * Manage, for a deputy who manages vendors (owner decision 2026-11-27): each of their vendors with its requests
 * waiting for a decision and its details over the next 120 days, a link to its locations and site contacts, and New
 * detail. Every detail opens on its Manage this detail tab.
 */
export default async function ManagePage() {
  const actor = await vendorManagerActor();
  const now = new Date();
  const view = await withTx((tx) => managerOverview(actor, tx, now));
  return (
    <div className="flex flex-col gap-6">
      <PageTitle
        sub="The vendors you manage for the agency: their requests, their details and their places."
        action={
          <ButtonLink href="/jobs/new">
            <Icon name="plus" size={20} />
            New detail
          </ButtonLink>
        }
      >
        Manage
      </PageTitle>
      {view.vendors.map((v) => (
        <section key={v.id} aria-labelledby={`vendor-${v.id}`} className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id={`vendor-${v.id}`} className="m-0 flex items-center gap-2 text-xl font-bold">
              {v.name}
              {v.active ? null : <Chip>Inactive</Chip>}
            </h2>
            <ActionLink href={`/manage/vendors/${v.id}`}>Locations and site contacts</ActionLink>
          </div>
          {v.requests.length ? (
            <CountSection title="Requests to decide" id={`requests-${v.id}`} count={v.requests.length}>
              <Rows tone="warning">
                {v.requests.map((d) => (
                  <DetailRow key={d.id} d={d} now={now} />
                ))}
              </Rows>
            </CountSection>
          ) : null}
          <CountSection title="Upcoming details" id={`upcoming-${v.id}`} count={v.upcoming.length}>
            {v.upcoming.length ? (
              <Rows>
                {v.upcoming.map((d) => (
                  <DetailRow key={d.id} d={d} now={now} />
                ))}
              </Rows>
            ) : (
              <Card>
                <p className="m-0 text-sm text-muted">No details in the next 120 days. Use New detail to add one.</p>
              </Card>
            )}
          </CountSection>
        </section>
      ))}
    </div>
  );
}
