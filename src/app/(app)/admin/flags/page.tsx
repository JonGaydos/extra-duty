import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { flagOverview } from "@/domain/admin/views";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { PageTitle } from "../../_personnel/TabLinks";
import { dateLabel, plural } from "../../_personnel/format";
import { CountSection, Row, Rows } from "../../coordinate/_coordinator/ui";
import { managementActor } from "../_admin/session";
import { AddFlag, FlagList, FlagRequestActions } from "../_admin/lists";

export const metadata: Metadata = { title: "Special flags" };

/** Requests waiting for a decision first, then every flag with how many people hold it. */
export default async function FlagsPage() {
  const actor = await managementActor();
  const { flags, requests } = await withTx((tx) => flagOverview(actor, tx));
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Qualifications such as K9 or Incident Commander. Positions can require them.">Special flags</PageTitle>
      <CountSection title="Requests" count={requests.length}>
        {requests.length ? (
          <Rows>
            {requests.map((r) => (
              <Row
                key={r.id}
                title={`${r.userName} asks for ${r.flagName}`}
                href={`/admin/users/${r.userId}`}
                meta={`Asked ${dateLabel(r.createdAt)}`}
                actions={r.canDecide ? <FlagRequestActions id={r.id} who={r.userName} /> : <span className="text-sm text-muted">An admin decides this one</span>}
              >
                {r.note ? <p className="m-0 text-body">{r.note}</p> : null}
              </Row>
            ))}
          </Rows>
        ) : (
          <Card pad={false}>
            <EmptyState title="No requests waiting">When someone asks for a flag on their profile, it shows up here.</EmptyState>
          </Card>
        )}
      </CountSection>
      <CountSection title="Flags" count={flags.filter((f) => f.active).length}>
        <FlagList items={flags.map((f) => ({ id: f.id, name: f.name, active: f.active, href: `/admin/flags/${f.id}`, meta: plural(f.holders, "person", "people") }))} />
      </CountSection>
      <CountSection title="Add a flag">
        <AddFlag />
      </CountSection>
    </div>
  );
}
