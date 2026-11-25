import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { listVendorContacts } from "@/domain/vendors/contacts";
import { listLocations } from "@/domain/vendors/vendors";
import { ContactsManager } from "../../coordinate/_coordinator/ContactsManager";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { MapsLink } from "@/ui/components/MapsLink";
import { PageTitle } from "../../_personnel/TabLinks";
import { vendorActor } from "../_vendor/session";
import { AddLocation, EditLocation } from "./LocationForms";

export const metadata: Metadata = { title: "Locations" };

/** The vendor's sites: name, address with Open in Maps, and site notes. Vendors add and edit their own. */
export default async function VendorLocationsPage() {
  const actor = await vendorActor();
  const vendorId = actor.vendorId ?? "";
  const { locations, contacts } = await withTx(async (tx) => ({
    locations: await listLocations(actor, tx, vendorId),
    contacts: await listVendorContacts(actor, tx, vendorId, { includeInactive: true }),
  }));

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Pick one of these when you request a detail. A coordinator can correct a map pin or retire a site.">Locations</PageTitle>
      <AddLocation />
      {locations.length === 0 ? (
        <Card pad={false}>
          <EmptyState title="No locations yet">Add the places where deputies work your details.</EmptyState>
        </Card>
      ) : (
        <Card pad={false} as="div">
          <ul className="m-0 list-none divide-y divide-divider p-0">
            {locations.map((l) => (
              <li key={l.id} className="flex flex-col gap-1 px-4 py-3.25">
                <span className="font-semibold">{l.name}</span>
                <span className="text-sm">{l.address ?? <span className="text-muted">No address yet</span>}</span>
                {l.address || l.lat !== null ? <MapsLink address={l.address} lat={l.lat} lng={l.lng} /> : null}
                {l.notes ? <p className="m-0 max-w-[70ch] text-sm whitespace-pre-line text-muted">{l.notes}</p> : null}
                <EditLocation location={{ id: l.id, name: l.name, address: l.address ?? "", notes: l.notes ?? "", lat: l.lat, lng: l.lng, source: l.geocodeSource }} />
              </li>
            ))}
          </ul>
        </Card>
      )}
      <section aria-labelledby="site-contacts" className="flex flex-col gap-2.5 pt-2">
        <h2 id="site-contacts" className="m-0 text-title font-semibold md:text-base">
          Site contacts
        </h2>
        <p className="m-0 max-w-[70ch] text-sm text-muted">The people deputies ask for when they arrive. Pick one when you request a detail.</p>
        <ContactsManager vendorId={vendorId} contacts={contacts} staff={false} />
      </section>
    </div>
  );
}
