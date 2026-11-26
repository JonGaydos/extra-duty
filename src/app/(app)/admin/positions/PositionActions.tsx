"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { FormField, Input } from "@/ui/components/FormField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { positionActiveAction, savePositionTypeAction } from "../_admin/actions";
import { Check, CheckGroup } from "../_admin/forms";

type Option = { id: string; name: string };
export type PositionFields = { name: string; eligibleRankIds: string[]; requiredQualificationIds: string[]; isIncidentCommander: boolean; vendorRequestable: boolean; differential: string };

function PositionForm({ id, initial, ranks, flags, submit, onDone }: Readonly<{ id?: string; initial: PositionFields; ranks: Option[]; flags: Option[]; submit: string; onDone: () => void }>) {
  const [v, setV] = useState(initial);
  const { run, busy } = useCoordAction();
  return (
    <form
      aria-label={submit}
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => savePositionTypeAction({ ...v, id }), onDone);
      }}
    >
      <div className="md:w-96">
        <FormField label="Name">
          <Input value={v.name} onChange={(e) => setV({ ...v, name: e.target.value })} required maxLength={100} />
        </FormField>
      </div>
      <div className="md:w-96">
        <FormField label="Pay differential per hour" hint="Added to each detail's base rate for this position. New details only; details already posted keep theirs.">
          <Input inputMode="decimal" value={v.differential} onChange={(e) => setV({ ...v, differential: e.target.value })} placeholder="0" className="max-w-40" />
        </FormField>
      </div>
      <CheckGroup legend="Ranks that can fill it" options={ranks} value={v.eligibleRankIds} onChange={(eligibleRankIds) => setV({ ...v, eligibleRankIds })} />
      {flags.length ? <CheckGroup legend="Special flags required" options={flags} value={v.requiredQualificationIds} onChange={(requiredQualificationIds) => setV({ ...v, requiredQualificationIds })} /> : null}
      <div className="flex flex-col">
        <Check label="Vendors can request it" hint="Shown on the vendor's request form." checked={v.vendorRequestable} onChange={(vendorRequestable) => setV({ ...v, vendorRequestable })} />
        <Check label="Incident commander" hint="The person in this spot commands the detail and cannot review its ops plan." checked={v.isIncidentCommander} onChange={(isIncidentCommander) => setV({ ...v, isIncidentCommander })} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" busy={busy}>
          {submit}
        </Button>
        <Button type="button" variant="secondary" onClick={onDone}>
          Close
        </Button>
      </div>
    </form>
  );
}

export function AddPosition({ ranks, flags }: Readonly<{ ranks: Option[]; flags: Option[] }>) {
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <Button onClick={() => setOpen(true)} className="w-fit">
        Add position type
      </Button>
    );
  return (
    <Card tone="accent" as="div">
      <h2 className="m-0 text-title font-semibold md:text-base">New position type</h2>
      <PositionForm
        ranks={ranks}
        flags={flags}
        submit="Add position type"
        onDone={() => setOpen(false)}
        initial={{ name: "", eligibleRankIds: [], requiredQualificationIds: [], isIncidentCommander: false, vendorRequestable: false, differential: "" }}
      />
    </Card>
  );
}

export function PositionRowActions({ id, name, active, initial, ranks, flags }: Readonly<{ id: string; name: string; active: boolean; initial: PositionFields; ranks: Option[]; flags: Option[] }>) {
  const [editing, setEditing] = useState(false);
  const { run, busy } = useCoordAction();
  if (editing)
    return (
      <div className="w-full">
        <PositionForm id={id} initial={initial} ranks={ranks} flags={flags} submit="Save position type" onDone={() => setEditing(false)} />
      </div>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" variant="secondary" aria-label={`Edit ${name}`} onClick={() => setEditing(true)}>
        Edit
      </Button>
      <Button size="sm" variant="secondary" busy={busy} aria-label={`${active ? "Turn off" : "Turn on"} ${name}`} onClick={() => run(() => positionActiveAction({ id, active: !active }))}>
        {active ? "Turn off" : "Turn on"}
      </Button>
    </div>
  );
}
