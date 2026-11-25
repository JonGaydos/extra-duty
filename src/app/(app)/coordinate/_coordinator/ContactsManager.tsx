"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmailLinks, SiteContact } from "@/ui/components/ContactList";
import { FormField, Input, TextArea } from "@/ui/components/FormField";
import { PhoneField } from "@/ui/components/PhoneField";
import { ActionStatus, useAction } from "../../_personnel/use-action";
import { addContactAction, contactActiveAction, updateContactAction, type ContactWire } from "./contact-actions";

export type ContactRow = { id: string; name: string; phone: string; email: string | null; notes: string | null; active: boolean };

const blank: ContactWire = { name: "", phone: "", email: "", notes: "" };

function Fields({ v, set, idPrefix }: { v: ContactWire; set: (v: ContactWire) => void; idPrefix: string }) {
  return (
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name">
          <Input id={`${idPrefix}-name`} value={v.name} onChange={(e) => set({ ...v, name: e.target.value })} required maxLength={120} autoComplete="off" />
        </FormField>
        <FormField label="Phone">
          <PhoneField id={`${idPrefix}-phone`} value={v.phone} onValue={(phone) => set({ ...v, phone })} required />
        </FormField>
        <FormField label="Email" hint="Optional">
          <Input id={`${idPrefix}-email`} type="email" value={v.email} onChange={(e) => set({ ...v, email: e.target.value })} maxLength={200} autoComplete="off" />
        </FormField>
        <FormField label="Notes" hint="Optional. Role, hours, where to find them.">
          <TextArea id={`${idPrefix}-notes`} value={v.notes} onChange={(e) => set({ ...v, notes: e.target.value })} maxLength={1000} className="min-h-11" />
        </FormField>
      </div>
  );
}

function AddContact({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(blank);
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-3">
      {open ? (
        <Card as="div">
          <form
            aria-label="New contact"
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => addContactAction({ vendorId, ...v }), () => {
                setV(blank);
                setOpen(false);
              });
            }}
          >
            <Fields v={v} set={setV} idPrefix="new-contact" />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" busy={busy}>
                Add contact
              </Button>
              <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Button size="sm" variant="secondary" className="w-fit" onClick={() => setOpen(true)}>
          Add a contact
        </Button>
      )}
      <ActionStatus result={result} />
    </div>
  );
}

function ContactItem({ c, staff }: { c: ContactRow; staff: boolean }) {
  const initial: ContactWire = { name: c.name, phone: c.phone, email: c.email ?? "", notes: c.notes ?? "" };
  const [editing, setEditing] = useState(false);
  const [v, setV] = useState(initial);
  const { run, busy, result } = useAction();
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.25">
      <div className="flex flex-col gap-2.5 md:flex-row md:items-start md:justify-between md:gap-4">
        <div className="flex min-w-0 flex-col gap-0.5">
          {c.active ? null : (
            <span className="flex">
              <Chip>Inactive</Chip>
            </span>
          )}
          <SiteContact name={c.name} phone={c.phone} staff={staff} />
          {c.email ? <EmailLinks emails={[c.email]} /> : null}
          {c.notes ? <p className="m-0 max-w-[70ch] text-sm whitespace-pre-line text-muted">{c.notes}</p> : null}
        </div>
        {editing ? null : (
          <div className="flex shrink-0 flex-wrap gap-2">
            {c.active ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setV(initial);
                  setEditing(true);
                }}
                aria-label={`Edit ${c.name}`}
              >
                Edit
              </Button>
            ) : null}
            <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => contactActiveAction({ contactId: c.id, active: !c.active }))} aria-label={`${c.active ? "Deactivate" : "Reactivate"} ${c.name}`}>
              {c.active ? "Deactivate" : "Reactivate"}
            </Button>
          </div>
        )}
      </div>
      {editing ? (
        <form
          aria-label={`Edit ${c.name}`}
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => updateContactAction({ contactId: c.id, ...v }), () => setEditing(false));
          }}
        >
          <Fields v={v} set={setV} idPrefix={`contact-${c.id}`} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" busy={busy}>
              Save contact
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Close
            </Button>
          </div>
        </form>
      ) : null}
      <ActionStatus result={result} />
    </li>
  );
}

/**
 * A vendor's site contacts: the people deputies ask for on site. Add, edit and deactivate; nothing is deleted, and
 * details keep their own copy of the name and number.
 */
export function ContactsManager({ vendorId, contacts, staff }: { vendorId: string; contacts: ContactRow[]; staff: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      {contacts.length === 0 ? (
        <Card>
          <p className="m-0 text-sm text-muted">No site contacts yet. They are offered on the detail form.</p>
        </Card>
      ) : (
        <Card pad={false} as="div">
          <ul className="m-0 list-none divide-y divide-divider p-0" aria-label="Site contacts">
            {contacts.map((c) => (
              <ContactItem key={`${c.id}-${c.name}-${c.phone}-${c.email}-${c.notes}-${c.active}`} c={c} staff={staff} />
            ))}
          </ul>
        </Card>
      )}
      <AddContact vendorId={vendorId} />
    </div>
  );
}
