import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { agencyDayKey } from "@/domain/time/agency-time";
import { listVendorDocuments } from "@/domain/vendors/vendors";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { Icon } from "@/ui/icons";
import { PageTitle } from "../../_personnel/TabLinks";
import { vendorActor } from "../_vendor/session";

export const metadata: Metadata = { title: "Contracts" };

const DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
/** A date-only value (YYYY-MM-DD) as "Dec 3, 2026". */
const day = (v: string) => DAY.format(new Date(`${v}T12:00:00Z`));

/** The vendor's contracts and documents on file with the agency. Read only; the coordinators add them. */
export default async function VendorContractsPage() {
  const actor = await vendorActor();
  const docs = await withTx((tx) => listVendorDocuments(actor, tx, actor.vendorId ?? ""));
  const today = agencyDayKey(new Date());

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Agreements on file with the agency. To add or replace one, send it to the coordinators.">Contracts</PageTitle>
      {docs.length === 0 ? (
        <Card pad={false}>
          <EmptyState title="No contract on file">Your agreement shows here once the coordinators add it. Details can still be requested.</EmptyState>
        </Card>
      ) : (
        <Card pad={false} as="div">
          <ul className="m-0 list-none divide-y divide-divider p-0">
            {docs.map((d) => {
              const expired = d.expiresOn !== null && d.expiresOn < today;
              return (
                <li key={d.id} className="flex flex-col gap-1 px-4 py-3.25">
                  <span className="flex flex-wrap items-center gap-2">
                    {d.url ? (
                      <a href={d.url} target="_blank" rel="noreferrer noopener" className="inline-flex min-h-11 items-center gap-1 font-semibold">
                        {d.label}
                        <span className="sr-only">, opens in a new tab</span>
                        <Icon name="external" size={16} />
                      </a>
                    ) : d.fileId ? (
                      <a href={`/api/v1/vendors/${d.vendorId}/documents/${d.id}/file`} className="inline-flex min-h-11 items-center gap-1 font-semibold" download>
                        {d.label}
                        <span className="sr-only">, download</span>
                        <Icon name="download" size={16} />
                      </a>
                    ) : (
                      <span className="font-semibold">{d.label}</span>
                    )}
                    {d.kind === "contract" ? <Chip>Contract</Chip> : null}
                    {expired ? <Chip tone="danger">Expired</Chip> : null}
                  </span>
                  <span className="text-sm text-muted">
                    {[d.signedOn ? `Signed ${day(d.signedOn)}` : null, d.expiresOn ? `${expired ? "Expired" : "Expires"} ${day(d.expiresOn)}` : "No expiration date", ].filter(Boolean).join(". ")}.
                  </span>
                </li>
              );
            })}
          </ul>
        </Card>
      )}
    </div>
  );
}
