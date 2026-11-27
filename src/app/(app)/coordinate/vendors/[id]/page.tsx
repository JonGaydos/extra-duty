import type { Metadata } from "next";
import { scheduleText } from "@/domain/invoices/send-schedule";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { staffDirectory, vendorRecord } from "@/domain/coordinator/views";
import { NotFoundError } from "@/domain/errors";
import { Card, CardTitle } from "@/ui/components/Card";
import { MapsLink } from "@/ui/components/MapsLink";
import { Chip } from "@/ui/components/Chip";
import { ContactList, EmailLinks, PhoneLink } from "@/ui/components/ContactList";
import { dollars } from "@/ui/components/PayLabel";
import { StatTile } from "@/ui/components/StatTile";
import { Icon } from "@/ui/icons";
import { dateLabel, hoursText, plural } from "../../../_personnel/format";
import { coordinatorActor } from "../../_coordinator/session";
import { VendorCurrentYearW9, VendorEmailApproved, VendorSendSchedule } from "../../_coordinator/ChoiceSave";
import { Notice } from "@/ui/components/Notice";
import { agencyDateParts } from "@/domain/time/agency-time";
import { dayText, vendorW9Gaps } from "@/domain/w9/w9";
import { getSettings } from "@/domain/settings/settings";
import { CountSection, Row, Rows } from "../../_coordinator/ui";
import { ContactsManager } from "../../_coordinator/ContactsManager";
import { EditLocation } from "../../../vendor/locations/LocationForms";
import { AddDocumentLink, AddLocation, AddLogin, EditVendor, LiftRestriction, LocationActive, NoteTools, PaymentHold, Restrict } from "../VendorActions";

export const metadata: Metadata = { title: "Vendor" };

type Props = { params: Promise<{ id: string }> };

const day = (key: string) => dateLabel(new Date(`${key}T12:00:00Z`));

type VendorRec = Awaited<ReturnType<typeof vendorRecord>>;

/** A document: a link, a file to download, or its label alone. */
function DocumentLabel({ d, vendorId }: Readonly<{ d: VendorRec["documents"][number]; vendorId: string }>) {
  if (d.url)
    return (
      <a href={d.url} target="_blank" rel="noreferrer noopener">
        {d.label}
      </a>
    );
  if (d.fileId)
    return (
      <a href={`/api/v1/vendors/${vendorId}/documents/${d.id}/file`} className="inline-flex items-center gap-1" download>
        {d.label}
        <span className="sr-only">, download</span>
        <Icon name="download" size={16} />
      </a>
    );
  return <>{d.label}</>;
}

/** An active location's address, map link, pin and detail count. */
function LocationMeta({ l }: Readonly<{ l: VendorRec["locations"][number] }>) {
  return (
    <span className="flex flex-col gap-0.5">
      <span className="text-ink">{l.address ?? "No address"}</span>
      {l.address || l.lat !== null ? <MapsLink address={l.address} lat={l.lat} lng={l.lng} /> : null}
      <span>
        {l.lat !== null ? "Pin set" : "No pin"}. {plural(l.details, "detail")}
      </span>
    </span>
  );
}

/** The vendor's facts, edit, payment hold, send schedule and email choice. */
function VendorCard({ rec, agencySchedule, w9Gaps, year }: Readonly<{ rec: VendorRec; agencySchedule: Parameters<typeof VendorSendSchedule>[0]["agency"]; w9Gaps: Awaited<ReturnType<typeof vendorW9Gaps>>; year: number }>) {
  const v = rec.vendor;
  return (
    <Card>
      <div className="flex flex-wrap gap-1.5">
        {v.active ? <Chip tone="success">Active</Chip> : <Chip>Inactive</Chip>}
        {v.paymentHold ? <Chip tone="danger">Payment hold</Chip> : null}
      </div>
      <h1 className="m-0 text-2xl font-bold md:text-3xl">{v.name}</h1>
      <ContactList
        items={[
          { label: "Contact", value: v.contactName },
          { label: "Phone", value: v.phone ? <PhoneLink phone={v.phone} /> : null },
          { label: v.billingEmails.length > 1 ? "Billing emails" : "Billing email", value: v.billingEmails.length ? <EmailLinks emails={v.billingEmails} /> : null },
          { label: "Default rate", value: v.defaultRateCents ? <span data-numeric>{dollars(v.defaultRateCents)}/hr</span> : "Agency default" },
          { label: "Minimum billable", value: v.minimumBillableMinutes ? hoursText(v.minimumBillableMinutes) : null },
          { label: "Vendor type", value: rec.typeName },
          {
            label: "Invoices go",
            value: (
              <span>
                {scheduleText(v.invoiceSendSchedule, { invoiceSendSchedule: agencySchedule })}. <a href="#send-settings">Change</a>
                {v.invoiceSendSchedule ? null : (
                  <>
                    {" "}
                    or <Link href="/admin/settings/billing">change the agency default</Link>
                  </>
                )}
              </span>
            ),
          },
          { label: "Email approved invoices", value: v.emailApprovedInvoices ? "Yes, approving sends them" : "No, approving does not send them" },
          { label: "W-9", value: v.requiresCurrentYearW9 ? "Must be signed this year" : "Any approved W-9" },
          { label: "Notes", value: v.notes ? <span className="whitespace-pre-line">{v.notes}</span> : null },
        ]}
      />
      <div className="flex flex-wrap gap-2" id="hold">
        <EditVendor
          vendorId={v.id}
          initial={{ name: v.name, contactName: v.contactName ?? "", phone: v.phone ?? "", billingEmails: v.billingEmails.join(", "), rate: v.defaultRateCents ? String(v.defaultRateCents / 100) : "", notes: v.notes ?? "" }}
        />
        <PaymentHold vendorId={v.id} onHold={v.paymentHold} />
      </div>
      <div id="send-settings" className="flex scroll-mt-24 flex-col gap-3">
        <VendorSendSchedule vendorId={v.id} current={v.invoiceSendSchedule} agency={agencySchedule} />
        <VendorEmailApproved vendorId={v.id} initial={v.emailApprovedInvoices} />
        <VendorCurrentYearW9 vendorId={v.id} initial={v.requiresCurrentYearW9} />
      </div>
      {w9Gaps.length ? (
        <Notice tone="warning">
          This vendor needs a W-9 signed in {year}. These payees have open invoices to it without one, so their invoices go without a W-9:{" "}
          {w9Gaps.map((g, i) => (
            <span key={g.userId}>
              {i ? ", " : ""}
              <Link href={`/admin/users/${g.userId}#w9`}>{g.name}</Link> ({g.signedOn ? `signed ${dayText(g.signedOn)}` : "no signature date"})
            </span>
          ))}
          .
        </Notice>
      ) : null}
      {v.paymentHold ? <p className="m-0 text-sm text-danger-ink">On hold: {v.paymentHoldReason}. Future details are locked and closed to sign-ups.</p> : null}
    </Card>
  );
}

/** One vendor's record: contact, payment hold, locations, contracts, deputy notes, payments, restrictions and logins. */
export default async function VendorPage({ params }: Readonly<Props>) {
  const actor = await coordinatorActor();
  const { id } = await params;
  const data = await withTx(async (tx) => {
    try {
      return { rec: await vendorRecord(actor, tx, id), people: await staffDirectory(actor, tx), agencySchedule: (await getSettings(tx)).invoiceSendSchedule, w9Gaps: await vendorW9Gaps(actor, tx, id) };
    } catch (e) {
      if (e instanceof NotFoundError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { rec } = data;
  const v = rec.vendor;
  const lastHold = rec.holds.find((h) => h.resolvedAt);

  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/coordinate/vendors" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to vendors
      </Link>
      <VendorCard rec={rec} agencySchedule={data.agencySchedule} w9Gaps={data.w9Gaps} year={agencyDateParts(new Date()).year} />

      <div className="grid gap-4.5 md:grid-cols-[minmax(0,1fr)_360px] md:items-start md:gap-6">
        <div className="flex min-w-0 flex-col gap-4.5">
          <CountSection title="Locations" count={rec.locations.filter((l) => l.active).length} action={<AddLocation vendorId={v.id} />}>
            {rec.locations.length === 0 ? (
              <Card>
                <p className="m-0 text-sm text-muted">No locations yet.</p>
              </Card>
            ) : (
              <Rows>
                {rec.locations.map((l) => (
                  <Row
                    key={l.id}
                    title={l.name}
                    meta={l.active ? <LocationMeta l={l} /> : "Deactivated, kept for history."}
                    actions={
                      <>
                        {l.active && l.lat === null ? <Chip tone="warning">Check pin</Chip> : null}
                        <LocationActive locationId={l.id} active={l.active} name={l.name} />
                      </>
                    }
                  >
                    {l.active ? <EditLocation location={{ id: l.id, name: l.name, address: l.address ?? "", notes: l.notes ?? "", lat: l.lat, lng: l.lng, source: l.geocodeSource }} /> : null}
                  </Row>
                ))}
              </Rows>
            )}
          </CountSection>

          <CountSection title="Site contacts" id="contacts" count={rec.contacts.filter((c) => c.active).length}>
            <ContactsManager vendorId={v.id} contacts={rec.contacts} staff />
          </CountSection>

          <CountSection title="Contracts and documents" id="documents" action={<AddDocumentLink vendorId={v.id} />}>
            <Card>
              {rec.documents.length === 0 ? (
                <p className="m-0 text-sm text-muted">No contract on file. Details can still be posted.</p>
              ) : (
                <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
                  {rec.documents.map((d) => (
                    <li key={d.id} className="flex flex-col gap-0.5">
                      <span className="flex flex-wrap items-center gap-2 font-semibold">
                        <DocumentLabel d={d} vendorId={v.id} />
                        {d.kind === "contract" ? <Chip>Contract</Chip> : null}
                      </span>
                      <span className="text-sm text-muted">
                        {[d.signedOn ? `Signed ${day(d.signedOn)}` : "", d.expiresOn ? `Expires ${day(d.expiresOn)}` : "", `Added ${dateLabel(d.createdAt)}`].filter(Boolean).join(". ")}.
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <p className="m-0 text-xs text-muted">Reminders go to coordinators 60 and 30 days before a contract expires.</p>
            </Card>
          </CountSection>

          <CountSection title="Deputy notes" count={rec.notes.length}>
            <p className="m-0 -mt-1 text-sm text-muted">Never shown to the vendor.</p>
            {rec.notes.length === 0 ? (
              <Card>
                <p className="m-0 text-sm text-muted">No notes yet.</p>
              </Card>
            ) : (
              <Rows>
                {rec.notes.map((n) => (
                  <Row key={n.id} title={n.body} meta={`${n.locationName ?? "All locations"}. ${n.authorName}, ${dateLabel(n.submittedAt)}.${n.status === "pending" ? " Waiting for review." : ""}`} actions={<NoteTools noteId={n.id} body={n.body} approved={n.status === "approved"} />} />
                ))}
              </Rows>
            )}
          </CountSection>
        </div>

        <div className="flex flex-col gap-4.5">
          <Card>
            <CardTitle>Payments</CardTitle>
            <div className="grid grid-cols-3 gap-2">
              <StatTile label="Overdue" value={dollars(rec.payments.overdueCents)} tone={rec.payments.overdueCents > 0 ? "warning" : "default"} />
              <StatTile label="Waiting" value={dollars(rec.payments.waitingCents)} />
              <StatTile label="Past issues" value={rec.payments.pastIssues} />
            </div>
            <p className="m-0 text-sm text-muted">
              {v.paymentHold ? "On payment hold now." : "No payment hold."} Last hold: {lastHold ? `${dateLabel(lastHold.placedAt)}, resolved ${dateLabel(lastHold.resolvedAt!)}` : "none"}.
            </p>
          </Card>
          <Card>
            <CardTitle>Restricted deputies</CardTitle>
            {rec.restrictions.length === 0 ? (
              <p className="m-0 text-sm text-muted">Nobody is restricted from this vendor.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
                {rec.restrictions.map((r) => (
                  <li key={r.id} className="flex items-start justify-between gap-2 py-2.5">
                    <span className="flex flex-col">
                      <span className="font-semibold">{r.userName}</span>
                      <span className="text-sm text-muted">
                        {r.reason}, {dateLabel(r.createdAt)}.{r.placedBy ? ` Placed by ${r.placedBy}.` : ""}
                      </span>
                    </span>
                    <LiftRestriction restrictionId={r.id} name={r.userName} />
                  </li>
                ))}
              </ul>
            )}
            <Restrict vendorId={v.id} people={data.people.filter((p) => p.role === "personnel")} />
            <p className="m-0 text-xs text-muted">Coordinators only. The vendor and the deputy are not told the reason.</p>
          </Card>
          <Card>
            <CardTitle>Vendor logins</CardTitle>
            {rec.logins.length === 0 ? (
              <p className="m-0 text-sm text-muted">No logins yet.</p>
            ) : (
              <ul className="m-0 flex list-none flex-col gap-2 p-0">
                {rec.logins.map((l) => (
                  <li key={l.userId} className="flex flex-col">
                    <span className="font-semibold">{l.name}</span>
                    <span className="text-sm text-muted">
                      {l.email}. {l.lastSignInAt ? `Last sign-in ${dateLabel(l.lastSignInAt)}` : "Not signed in yet"}
                      {l.active ? "" : ", deactivated"}.
                    </span>
                  </li>
                ))}
              </ul>
            )}
            <AddLogin vendorId={v.id} />
          </Card>
        </div>
      </div>
    </div>
  );
}
