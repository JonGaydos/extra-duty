"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { FormField, Input } from "@/ui/components/FormField";
import { Icon } from "@/ui/icons";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import {
  createFlagAction,
  createRankAction,
  deactivateRankAction,
  decideFlagRequestAction,
  flagActiveAction,
  listActiveAction,
  listCreateAction,
  listRenameAction,
  moveRankAction,
  renameFlagAction,
} from "./actions";
import { AddItem, ListEditor, type ListItem } from "./ListEditor";

/** Client wrappers that bind each Management list to its server actions. */

export function FlagList({ items }: { items: ListItem[] }) {
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

export function NamedList({ list, items, noun }: { list: string; items: ListItem[]; noun: string }) {
  return (
    <ListEditor
      items={items}
      empty={{ title: `No ${noun}s yet`, text: `Add the first ${noun} above.` }}
      onRename={(id, name) => listRenameAction({ list, id, name })}
      onActive={(id, active) => listActiveAction({ list, id, active })}
    />
  );
}

export function AddNamed({ list, noun }: { list: string; noun: string }) {
  const label = noun.charAt(0).toUpperCase() + noun.slice(1);
  return <AddItem label={`${label} name`} button={`Add ${noun}`} onAdd={(name) => listCreateAction({ list, name })} />;
}

export type RankItem = { id: string; name: string; active: boolean; inLadder: boolean; holders: number };

/** Ranks in ladder order, lowest first, with move up and down. */
export function RankList({ ranks }: { ranks: RankItem[] }) {
  const { run, busy } = useCoordAction();
  return (
    <Card pad={false} as="div">
      <ol className="m-0 list-none divide-y divide-divider p-0">
        {ranks.map((r, i) => (
          <li key={r.id} className="flex flex-col gap-2.5 px-4 py-3.25 md:flex-row md:items-center md:justify-between">
            <div className="flex min-w-0 flex-col gap-1">
              <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
                <span className="w-6 text-muted" data-numeric aria-hidden="true">
                  {i + 1}
                </span>
                {r.name}
                {!r.inLadder ? <Chip tone="info">Outside the ladder</Chip> : null}
                {!r.active ? <Chip>Off</Chip> : null}
              </p>
              <p className="m-0 pl-8 text-sm text-muted">{r.holders === 1 ? "1 person" : `${r.holders} people`}</p>
            </div>
            <div className="flex shrink-0 flex-wrap gap-2 pl-8 md:pl-0">
              <Button size="sm" variant="secondary" disabled={busy || i === 0} aria-label={`Move ${r.name} lower`} onClick={() => run(() => moveRankAction({ id: r.id, by: -1 }))}>
                <Icon name="down" size={18} />
                Lower
              </Button>
              <Button size="sm" variant="secondary" disabled={busy || i === ranks.length - 1} aria-label={`Move ${r.name} higher`} onClick={() => run(() => moveRankAction({ id: r.id, by: 1 }))}>
                <Icon name="up" size={18} />
                Higher
              </Button>
              {r.active ? (
                <Button size="sm" variant="secondary" disabled={busy || r.holders > 0} aria-label={`Turn off ${r.name}`} onClick={() => run(() => deactivateRankAction(r.id))}>
                  Turn off
                </Button>
              ) : null}
            </div>
          </li>
        ))}
      </ol>
    </Card>
  );
}

export function AddRank() {
  return <AddItem label="Rank name" button="Add rank" onAdd={(name) => createRankAction(name)} />;
}

/** A flag request: approve at once, or deny with a reason the person sees. */
export function FlagRequestActions({ id, who }: { id: string; who: string }) {
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
