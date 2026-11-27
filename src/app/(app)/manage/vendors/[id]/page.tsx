import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { managesVendor } from "@/domain/auth/policy";
import { listVendorContacts } from "@/domain/vendors/contacts";
import { listLocations } from "@/domain/vendors/vendors";
import { managedVendors } from "@/domain/vendors/managers";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { MapsLink } from "@/ui/components/MapsLink";
import { Icon } from "@/ui/icons";
import { PageTitle } from "../../../_personnel/TabLinks";
import { ContactsManager } from "../../../coordinate/_coordinator/ContactsManager";
import { CountSection, Row, Rows } from "../../../coordinate/_coordinator/ui";
import { AddLocation, LocationActive } from "../../../coordinate/vendors/VendorActions";
import { EditLocation } from "../../../vendor/locations/LocationForms";
import { vendorManagerActor } from "../../session";

export const metadata: Metadata = { title: "Locations and site contacts" };

type Props = { params: Promise<{ id: string }> };

/** A managed vendor's locations (add, edit, place the pin, deactivate) and site contacts, for its vendor manager. */
export default async function ManagedVendorPage({ params }: Readonly<Props>) {
  const actor = await vendorManagerActor();
  const { id } = await params;
  if (!managesVendor(actor, id)) notFound();
  const data = await withTx(async (tx) => ({
    vendor: (await managedVendors(actor, tx)).find((v) => v.id === id),
    locations: await listLocations(actor, tx, id, { includeInactive: true }),
    contacts: await listVendorContacts(actor, tx, id, { includeInactive: true }),
  }));
  if (!data.vendor) notFound();
  const active = data.locations.filter((l) => l.active);
  return (
    <div className="flex flex-col gap-4.5">
      <Link href="/manage" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to Manage
      </Link>
      <PageTitle sub="Locations and site contacts are offered on this vendor's details.">{data.vendor.name}</PageTitle>
      <div className="grid gap-4.5 md:grid-cols-2 md:items-start md:gap-6">
        <CountSection title="Locations" count={active.length} action={<AddLocation vendorId={id} />}>
          {data.locations.length === 0 ? (
            <Card>
              <p className="m-0 text-sm text-muted">No locations yet.</p>
            </Card>
          ) : (
            <Rows>
              {[...active, ...data.locations.filter((l) => !l.active)].map((l) => (
                <Row
                  key={l.id}
                  title={l.name}
                  meta={
                    l.active ? (
                      <span className="flex flex-col gap-0.5">
                        <span className="text-ink">{l.address ?? "No address"}</span>
                        {l.address || l.lat !== null ? <MapsLink address={l.address} lat={l.lat} lng={l.lng} /> : null}
                      </span>
                    ) : (
                      "Deactivated, kept for history."
                    )
                  }
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
        <CountSection title="Site contacts" id="contacts" count={data.contacts.filter((c) => c.active).length}>
          <ContactsManager vendorId={id} contacts={data.contacts} staff />
        </CountSection>
      </div>
    </div>
  );
}
