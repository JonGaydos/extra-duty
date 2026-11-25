"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { AddressField, addressValue } from "@/ui/components/AddressField";
import { FormField, Input } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import { hhmmText } from "../../_personnel/format";
import { keyLabel } from "./DatesStep";
import type { TimeOverride } from "./detail-summary";

/** Detail form parts shared by the coordinator's new detail form and the vendor's request form. */

export type { TimeOverride };
export type FlexWire = { earliest: string; latest: string; allowShorter: boolean };
import type { SafetyAddressRow } from "./safety-wire";

export { safetyRows, safetyWire, type SafetyAddressRow, type SafetyAddressWire } from "./safety-wire";

/** Earliest start, latest finish and shorter shifts. */
export function FlexFields({ flex, onFlex }: { flex: FlexWire; onFlex: (f: FlexWire) => void }) {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <FormField label="Earliest start">
        <Input type="time" value={flex.earliest} onChange={(e) => onFlex({ ...flex, earliest: e.target.value })} required />
      </FormField>
      <FormField label="Latest finish">
        <Input type="time" value={flex.latest} onChange={(e) => onFlex({ ...flex, latest: e.target.value })} required />
      </FormField>
      <label className="flex min-h-11 items-center gap-2 sm:col-span-2">
        <input type="checkbox" checked={flex.allowShorter} onChange={(e) => onFlex({ ...flex, allowShorter: e.target.checked })} className="size-4.5 accent-accent" />
        Allow shorter shifts (pending until 24 hours before the start)
      </label>
    </div>
  );
}

/** Officer safety addresses of concern, up to 10, each looked up on OpenStreetMap with a pin that can be moved. */
export function SafetyAddressFields({ addresses, onAddresses }: { addresses: SafetyAddressRow[]; onAddresses: (v: SafetyAddressRow[]) => void }) {
  const set = (i: number, patch: Partial<SafetyAddressRow>) => onAddresses(addresses.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <>
      {addresses.map((a, i) => (
        <div key={i} className="flex flex-col gap-2 rounded-md border border-line p-3">
          <AddressField label={`Address of concern ${i + 1}`} value={a.value} onChange={(value) => set(i, { value })} pin />
          <div className="grid gap-2 sm:grid-cols-[1fr_auto] sm:items-end">
            <FormField label="What to know">
              <Input value={a.description} onChange={(e) => set(i, { description: e.target.value })} />
            </FormField>
            <Button variant="secondary" onClick={() => onAddresses(addresses.filter((_, j) => j !== i))} aria-label={`Remove address ${i + 1}`}>
              Remove
            </Button>
          </div>
        </div>
      ))}
      {addresses.length < 10 ? (
        <Button variant="secondary" className="w-fit" onClick={() => onAddresses([...addresses, { value: addressValue(""), description: "" }])}>
          <Icon name="plus" size={18} />
          {addresses.length ? "Add another address" : "Add an address"}
        </Button>
      ) : null}
    </>
  );
}

/** One row of the preview: the date, its times (changeable) and Remove. */
export function PreviewRow({ date, start, end, override, error, onOverride, onRemove }: { date: string; start: string; end: string; override?: TimeOverride; error?: string; onOverride: (o: TimeOverride | null) => void; onRemove: () => void }) {
  const [editing, setEditing] = useState(false);
  const s = override?.startTime ?? start;
  const e = override?.endTime ?? end;
  const label = keyLabel(date);
  return (
    <li id={`preview-${date}`} className="flex flex-col gap-2 px-3.5 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span>
          <span className="font-semibold">{label}</span>{" "}
          <span className="text-muted">
            {s && e ? `${hhmmText(s)} to ${hhmmText(e)}` : "Set the times above"}
            {override ? " (changed)" : ""}
          </span>
        </span>
        <span className="flex gap-1">
          <Button size="sm" variant="secondary" onClick={() => setEditing(!editing)} aria-expanded={editing} aria-label={`Change times, ${label}`}>
            Change times
          </Button>
          <Button size="sm" variant="secondary" onClick={onRemove} aria-label={`Remove ${label}`}>
            Remove
          </Button>
        </span>
      </div>
      {editing ? (
        <div className="flex flex-wrap items-end gap-2">
          <FormField label={`Start, ${label}`}>
            <Input type="time" value={s} onChange={(ev) => onOverride({ ...override, startTime: ev.target.value })} className="max-w-36" />
          </FormField>
          <FormField label={`End, ${label}`}>
            <Input type="time" value={e} onChange={(ev) => onOverride({ ...override, endTime: ev.target.value })} className="max-w-36" />
          </FormField>
          {override ? (
            <Button size="sm" variant="secondary" onClick={() => onOverride(null)}>
              Use the usual times
            </Button>
          ) : null}
        </div>
      ) : null}
      {error ? (
        <p className="m-0 text-xs font-medium text-danger-ink" role="alert">
          {error}
        </p>
      ) : null}
    </li>
  );
}

