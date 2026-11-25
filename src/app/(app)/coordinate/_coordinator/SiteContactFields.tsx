"use client";

import { FormField, Input, Select } from "@/ui/components/FormField";
import { PhoneField } from "@/ui/components/PhoneField";
import type { NewContactWire } from "./detail-input";

export type ContactOption = { id: string; name: string; phone: string };
export type SiteContactValue = { contactName: string; contactPhone: string; newContact: NewContactWire | null };

const NONE = "";
const NEW = "new";
const CURRENT = "current";
const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Which dropdown entry the detail's contact copy matches: a saved contact, a name kept on this detail only, or none. */
export function contactChoice(contacts: ContactOption[], v: SiteContactValue): string {
  if (v.newContact) return NEW;
  if (!v.contactName.trim()) return NONE;
  return contacts.find((c) => same(c.name, v.contactName))?.id ?? CURRENT;
}

/**
 * "Site contact" as a dropdown of the vendor's active contacts plus "Add a new contact". Choosing a contact fills
 * Contact phone, which stays editable for this detail. A new contact is saved to the vendor when the form saves.
 */
export function SiteContactFields({ contacts, value, onChange, disabled, vendorChosen = true }: { contacts: ContactOption[]; value: SiteContactValue; onChange: (v: SiteContactValue) => void; disabled?: boolean; vendorChosen?: boolean }) {
  const choice = contactChoice(contacts, value);
  const choose = (id: string) => {
    if (id === NEW) return onChange({ contactName: "", contactPhone: "", newContact: { name: "", phone: "", email: "" } });
    if (id === NONE) return onChange({ contactName: "", contactPhone: "", newContact: null });
    const c = contacts.find((x) => x.id === id);
    if (c) onChange({ contactName: c.name, contactPhone: c.phone, newContact: null });
  };
  const n = value.newContact;
  const setNew = (patch: Partial<NewContactWire>) => {
    const next = { ...n!, ...patch };
    onChange({ contactName: next.name, contactPhone: next.phone, newContact: next });
  };
  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Site contact" hint={!vendorChosen ? "Choose a vendor first." : contacts.length === 0 && !n ? "No saved contacts yet." : undefined}>
          <Select value={choice} onChange={(e) => choose(e.target.value)} disabled={disabled || !vendorChosen}>
            <option value={NONE}>No site contact</option>
            {contacts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            {choice === CURRENT ? <option value={CURRENT}>{value.contactName} (this detail only)</option> : null}
            <option value={NEW}>Add a new contact</option>
          </Select>
        </FormField>
        {n ? (
          <FormField label="Contact name">
            <Input value={n.name} onChange={(e) => setNew({ name: e.target.value })} required maxLength={120} autoComplete="off" />
          </FormField>
        ) : choice !== NONE ? (
          <FormField label="Contact phone" hint="Filled from the contact. A change here applies to this detail only.">
            <PhoneField value={value.contactPhone} onValue={(p) => onChange({ ...value, contactPhone: p })} disabled={disabled} />
          </FormField>
        ) : null}
      </div>
      {n ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Contact phone">
            <PhoneField value={n.phone} onValue={(p) => setNew({ phone: p })} required />
          </FormField>
          <FormField label="Contact email" hint="Optional">
            <Input type="email" value={n.email} onChange={(e) => setNew({ email: e.target.value })} maxLength={200} autoComplete="off" />
          </FormField>
          <p className="m-0 text-xs text-muted sm:col-span-2">Saved to the vendor&apos;s contacts for future details.</p>
        </div>
      ) : null}
    </div>
  );
}
