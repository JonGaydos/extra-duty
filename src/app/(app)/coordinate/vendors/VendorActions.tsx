"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { AddressField, addressValue, pinWire } from "@/ui/components/AddressField";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { PhoneField } from "@/ui/components/PhoneField";
import {
  addDocumentLinkAction,
  addLocationAction,
  addLoginAction,
  createVendorAction,
  editNoteAction,
  liftRestrictionAction,
  locationActiveAction,
  paymentHoldAction,
  restrictAction,
  retireNoteAction,
  updateVendorAction,
} from "../_coordinator/actions";
import { useCoordAction } from "../_coordinator/status";

type VendorFields = { name: string; contactName: string; phone: string; billingEmails: string; rate: string; notes: string };

function VendorFieldsForm({ value, onChange }: { value: VendorFields; onChange: (v: VendorFields) => void }) {
  const set = (k: keyof VendorFields) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => onChange({ ...value, [k]: e.target.value });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField label="Vendor name">
        <Input value={value.name} onChange={set("name")} required maxLength={200} />
      </FormField>
      <FormField label="Contact name">
        <Input value={value.contactName} onChange={set("contactName")} maxLength={200} />
      </FormField>
      <FormField label="Phone">
        <PhoneField value={value.phone} onValue={(phone) => onChange({ ...value, phone })} />
      </FormField>
      <FormField label="Billing emails" hint="Separate several with commas.">
        <Input value={value.billingEmails} onChange={set("billingEmails")} maxLength={1000} />
      </FormField>
      <FormField label="Default rate per hour" hint="Blank uses the agency default.">
        <Input inputMode="decimal" value={value.rate} onChange={set("rate")} />
      </FormField>
      <FormField label="Notes" hint="Coordinators only.">
        <TextArea value={value.notes} onChange={set("notes")} maxLength={4000} />
      </FormField>
    </div>
  );
}

export function NewVendor() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<VendorFields>({ name: "", contactName: "", phone: "", billingEmails: "", rate: "", notes: "" });
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} className="w-fit">
        Add vendor
      </Button>
    );
  return (
    <Card tone="accent" as="div">
      <CardTitle>Add vendor</CardTitle>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => createVendorAction(v), (r) => router.push(`/coordinate/vendors/${r.value}`), { refresh: false });
        }}
      >
        <VendorFieldsForm value={v} onChange={setV} />
        <div className="flex gap-2">
          <Button type="submit" busy={busy}>
            Add vendor
          </Button>
          <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
            Close
          </Button>
        </div>
      </form>
    </Card>
  );
}

export function EditVendor({ vendorId, initial }: { vendorId: string; initial: VendorFields }) {
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(initial);
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button variant="secondary" onClick={() => setOpen(true)}>
        Edit vendor
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => updateVendorAction({ ...v, vendorId }), () => setOpen(false));
      }}
    >
      <VendorFieldsForm value={v} onChange={setV} />
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Save vendor
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function PaymentHold({ vendorId, onHold }: { vendorId: string; onHold: boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [outcome, setOutcome] = useState<"fix_coming" | "handled">("handled");
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button variant={onHold ? "primary" : "secondary"} onClick={() => setOpen(true)}>
        {onHold ? "Resolve payment hold" : "Place payment hold"}
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => paymentHoldAction({ vendorId, place: !onHold, reason, outcome }), () => setOpen(false));
      }}
    >
      {onHold ? (
        <FormField label="Outcome">
          <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
            <option value="handled">Handled</option>
            <option value="fix_coming">Fix coming</option>
          </Select>
        </FormField>
      ) : null}
      <FormField label={onHold ? "Note" : "Reason"} hint={onHold ? "Optional" : "Future details lock and the people on them are told."}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} required={!onHold} maxLength={500} />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" variant={onHold ? "primary" : "danger"} busy={busy}>
          {onHold ? "Resolve hold" : "Place hold"}
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function AddLocation({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [address, setAddress] = useState(() => addressValue(""));
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Add location
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-3 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        const pin = pinWire(address);
        run(() => addLocationAction({ vendorId, name, address: address.address, ...(pin === undefined ? {} : { pin }) }), () => {
          setName("");
          setAddress(addressValue(""));
          setOpen(false);
        });
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Location name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </FormField>
      </div>
      <AddressField label="Address" hint="Street, city and ZIP. Used for the map pin." value={address} onChange={setAddress} pin />
      <div className="flex gap-2">
        <Button type="submit" size="sm" busy={busy}>
          Add location
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function LocationActive({ locationId, active, name }: { locationId: string; active: boolean; name: string }) {
  const { run, busy } = useCoordAction();
  return (
    <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => locationActiveAction({ locationId, active: !active }))} aria-label={`${active ? "Deactivate" : "Reactivate"}, ${name}`}>
      {active ? "Deactivate" : "Reactivate"}
    </Button>
  );
}

/** Uploads through the documents API (multipart), so large files skip the server action body limit. */
async function uploadDocument(vendorId: string, form: { kind: string; label: string; signedOn: string; expiresOn: string }, file: File) {
  const body = new FormData();
  for (const [k, v] of Object.entries(form)) if (v) body.set(k, v);
  body.set("file", file);
  const res = await fetch(`/api/v1/vendors/${vendorId}/documents`, { method: "POST", body });
  if (res.ok) return { ok: true as const, message: "Document uploaded." };
  const err = await res.json().catch(() => null);
  return { ok: false as const, error: err?.error?.message ?? "The upload did not go through. Check the file and try again." };
}

export function AddDocumentLink({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState<"link" | "file" | null>(null);
  const [f, setF] = useState({ kind: "contract" as "contract" | "other", label: "", url: "", signedOn: "", expiresOn: "" });
  const [file, setFile] = useState<File | null>(null);
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setOpen("file")}>
          Upload
        </Button>
        <Button size="sm" variant="secondary" onClick={() => setOpen("link")}>
          Add link
        </Button>
      </div>
    );
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        const meta = { kind: f.kind, label: f.label, signedOn: f.signedOn, expiresOn: f.expiresOn };
        run(() => (open === "file" && file ? uploadDocument(vendorId, meta, file) : addDocumentLinkAction({ vendorId, ...f })), () => setOpen(null));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Kind">
          <Select value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value as "contract" | "other" })}>
            <option value="contract">Contract</option>
            <option value="other">Other document</option>
          </Select>
        </FormField>
        <FormField label="Label">
          <Input value={f.label} onChange={(e) => setF({ ...f, label: e.target.value })} required maxLength={200} />
        </FormField>
        {open === "link" ? (
          <FormField label="Link" hint="Must start with https://">
            <Input type="url" value={f.url} onChange={(e) => setF({ ...f, url: e.target.value })} required />
          </FormField>
        ) : (
          <FormField label="File" hint="PDF or Word">
            <Input type="file" accept=".pdf,.doc,.docx" onChange={(e) => setFile(e.target.files?.[0] ?? null)} required className="py-2" />
          </FormField>
        )}
        <FormField label="Signed on" hint="Optional">
          <Input type="date" value={f.signedOn} onChange={(e) => setF({ ...f, signedOn: e.target.value })} />
        </FormField>
        <FormField label="Expires on" hint="Optional. Coordinators are reminded 60 and 30 days before.">
          <Input type="date" value={f.expiresOn} onChange={(e) => setF({ ...f, expiresOn: e.target.value })} />
        </FormField>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" busy={busy}>
          {open === "file" ? "Upload" : "Add link"}
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(null)}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function NoteTools({ noteId, body, approved }: { noteId: string; body: string; approved: boolean }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(body);
  const { run, busy } = useCoordAction();
  if (editing)
    return (
      <form
        className="flex w-full flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => editNoteAction({ noteId, body: text }), () => setEditing(false));
        }}
      >
        <FormField label="Note">
          <TextArea value={text} onChange={(e) => setText(e.target.value)} required maxLength={2000} />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" busy={busy}>
            Save note
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
            Close
          </Button>
        </div>
      </form>
    );
  return (
    <div className="flex flex-wrap gap-1.5">
      <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
        Edit
      </Button>
      {approved ? (
        <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => retireNoteAction(noteId))}>
          Retire
        </Button>
      ) : null}
    </div>
  );
}

export function Restrict({ vendorId, people }: { vendorId: string; people: Array<{ id: string; name: string }> }) {
  const [open, setOpen] = useState(false);
  const [userId, setUserId] = useState("");
  const [reason, setReason] = useState("");
  const [remove, setRemove] = useState(true);
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Restrict a deputy
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => restrictAction({ vendorId, userId, reason, removeFromFutureDetails: remove }), () => setOpen(false));
      }}
    >
      <FormField label="Deputy">
        <Select value={userId} onChange={(e) => setUserId(e.target.value)} required>
          <option value="">Choose a deputy</option>
          {people.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </Select>
      </FormField>
      <FormField label="Reason" hint="Coordinators only. The vendor and the deputy are not told the reason.">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
      </FormField>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={remove} onChange={(e) => setRemove(e.target.checked)} className="size-4.5 accent-accent" />
        Remove them from this vendor&apos;s future details
      </label>
      <div className="flex gap-2">
        <Button type="submit" size="sm" busy={busy}>
          Restrict
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function LiftRestriction({ restrictionId, name }: { restrictionId: string; name: string }) {
  const { run, busy } = useCoordAction();
  return (
    <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => liftRestrictionAction(restrictionId))} aria-label={`Lift, ${name}`}>
      Lift
    </Button>
  );
}

export function AddLogin({ vendorId }: { vendorId: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Add login
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addLoginAction({ vendorId, name, email }), () => setOpen(false));
      }}
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Name">
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </FormField>
        <FormField label="Email">
          <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </FormField>
      </div>
      <div className="flex gap-2">
        <Button type="submit" size="sm" busy={busy}>
          Add and invite
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Close
        </Button>
      </div>
    </form>
  );
}
