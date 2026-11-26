"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { AddressField, addressValue, pinWire, type AddressValue } from "@/ui/components/AddressField";
import { FormField, Input, TextArea } from "@/ui/components/FormField";
import { ActionStatus, useAction } from "../../_personnel/use-action";
import { addLocationAction, updateLocationAction } from "../_vendor/actions";

type Values = { name: string; address: AddressValue; notes: string };
export type SavedLocation = { id: string; name: string; address: string; notes: string; lat: number | null; lng: number | null; source: "auto" | "manual" };

const wire = (v: Values) => {
  const pin = pinWire(v.address);
  return { name: v.name, address: v.address.address, notes: v.notes, ...(pin === undefined ? {} : { pin }) };
};

function Fields({ v, set }: Readonly<{ v: Values; set: (v: Values) => void }>) {
  return (
    <>
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Location name">
          <Input value={v.name} onChange={(e) => set({ ...v, name: e.target.value })} required maxLength={200} />
        </FormField>
      </div>
      <AddressField label="Address" hint="Street, city and ZIP. Used for the map pin." value={v.address} onChange={(address) => set({ ...v, address })} pin />
      <FormField label="Site notes" hint="Optional. Parking, gates, where to check in.">
        <TextArea value={v.notes} onChange={(e) => set({ ...v, notes: e.target.value })} maxLength={2000} />
      </FormField>
    </>
  );
}

export function AddLocation() {
  const empty: Values = { name: "", address: addressValue(""), notes: "" };
  const [open, setOpen] = useState(false);
  const [v, setV] = useState(empty);
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-3">
      {open ? (
        <Card>
          <CardTitle>New location</CardTitle>
          <form
            className="flex flex-col gap-3"
            onSubmit={(e) => {
              e.preventDefault();
              run(() => addLocationAction(wire(v)), () => {
                setV(empty);
                setOpen(false);
              });
            }}
          >
            <Fields v={v} set={setV} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" busy={busy}>
                Add location
              </Button>
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Close
              </Button>
            </div>
          </form>
        </Card>
      ) : (
        <Button className="w-full sm:w-fit" onClick={() => setOpen(true)}>
          Add a location
        </Button>
      )}
      <ActionStatus result={result} />
    </div>
  );
}

export function EditLocation({ location }: Readonly<{ location: SavedLocation }>) {
  const initial: Values = { name: location.name, address: addressValue(location.address, location.lat, location.lng, location.source), notes: location.notes };
  const [open, setOpen] = useState(false);
  const [v, setV] = useState<Values>(initial);
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <form
          className="flex flex-col gap-3 pt-1"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => updateLocationAction({ locationId: location.id, ...wire(v) }), () => setOpen(false));
          }}
        >
          <Fields v={v} set={setV} />
          <div className="flex flex-wrap gap-2">
            <Button type="submit" size="sm" busy={busy}>
              Save location
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </form>
      ) : (
        <Button
          size="sm"
          variant="secondary"
          className="w-fit"
          onClick={() => {
            setV(initial);
            setOpen(true);
          }}
          aria-label={`Edit ${location.name}`}
        >
          Edit
        </Button>
      )}
      <ActionStatus result={result} />
    </div>
  );
}
