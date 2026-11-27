"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import {
  createFlagAction,
  decideFlagRequestAction,
  flagActiveAction,
  listActiveAction,
  listCreateAction,
  listRenameAction,
  renameFlagAction,
} from "./actions";
import { AddItem, ListEditor, type ListItem } from "./ListEditor";

/** Client wrappers that bind each Management list to its server actions. */

export function FlagList({ items }: Readonly<{ items: ListItem[] }>) {
  return (
    <ListEditor
      items={items}
      empty={{ title: "No special flags", text: "Add a flag, such as K9 or Motors, to require it on a position." }}
      onRename={(id, name) => renameFlagAction({ id, name })}
      onActive={(id, active) => flagActiveAction({ id, active })}
    />
  );
}

export function AddFlag() {
  return <AddItem label="Flag name" button="Add flag" onAdd={(name) => createFlagAction(name)} />;
}

export function NamedList({ list, items, noun }: Readonly<{ list: string; items: ListItem[]; noun: string }>) {
  return (
    <ListEditor
      items={items}
      empty={{ title: `No ${noun}s yet`, text: `Add the first ${noun} above.` }}
      onRename={(id, name) => listRenameAction({ list, id, name })}
      onActive={(id, active) => listActiveAction({ list, id, active })}
    />
  );
}

export function AddNamed({ list, noun }: Readonly<{ list: string; noun: string }>) {
  const label = noun.charAt(0).toUpperCase() + noun.slice(1);
  return <AddItem label={`${label} name`} button={`Add ${noun}`} onAdd={(name) => listCreateAction({ list, name })} />;
}

/** A flag request: approve at once, or deny with a reason the person sees. */
export function FlagRequestActions({ id, who }: Readonly<{ id: string; who: string }>) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();
  if (denying)
    return (
      <form
        className="flex w-full flex-col gap-2 md:w-80"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => decideFlagRequestAction({ id, approve: false, reason }));
        }}
      >
        <FormField label="Reason for denying" hint={`${who} sees this.`}>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} autoFocus />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="danger" busy={busy}>
            Deny request
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setDenying(false)}>
            Close
          </Button>
        </div>
      </form>
    );
  return (
    <>
      <Button size="sm" busy={busy} onClick={() => run(() => decideFlagRequestAction({ id, approve: true, reason: "" }))}>
        Approve
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setDenying(true)}>
        Deny
      </Button>
    </>
  );
}
