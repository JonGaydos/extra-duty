"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { FormField, Input } from "@/ui/components/FormField";
import type { ActionResult } from "../../_personnel/result";
import { useCoordAction } from "../../coordinate/_coordinator/status";

export type ListItem = { id: string; name: string; active: boolean; meta?: string; href?: string };

/** "Add" form for a list: one text field and a button. */
export function AddItem({ label, button, onAdd }: Readonly<{ label: string; button: string; onAdd: (name: string) => Promise<ActionResult> }>) {
  const [name, setName] = useState("");
  const { run, busy } = useCoordAction();
  return (
    <form
      aria-label={button}
      className="flex flex-col gap-2 md:flex-row md:items-end"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => onAdd(name), () => setName(""));
      }}
    >
      <div className="md:w-80">
        <FormField label={label}>
          <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} />
        </FormField>
      </div>
      <Button type="submit" busy={busy} className="w-full md:w-fit">
        {button}
      </Button>
    </form>
  );
}

/** The item's name (a link when it has a page), an Off chip when turned off, and its details line. */
function ItemText({ item }: Readonly<{ item: ListItem }>) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <p className="m-0 flex flex-wrap items-center gap-2 font-semibold">
        {item.href ? (
          <Link href={item.href} className="text-ink hover:text-link">
            {item.name}
          </Link>
        ) : (
          item.name
        )}
        {!item.active ? <Chip>Off</Chip> : null}
      </p>
      {item.meta ? <p className="m-0 text-sm text-muted">{item.meta}</p> : null}
    </div>
  );
}

function ItemRow({ item, onRename, onActive, renameLabel }: Readonly<{ item: ListItem; onRename?: (id: string, name: string) => Promise<ActionResult>; onActive?: (id: string, active: boolean) => Promise<ActionResult>; renameLabel: string }>) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);
  const { run, busy } = useCoordAction();
  return (
    <li className="flex flex-col gap-2.5 px-4 py-3.25 md:flex-row md:items-center md:justify-between md:gap-4">
      {editing && onRename ? (
        <form
          className="flex flex-1 flex-col gap-2 md:flex-row md:items-end"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => onRename(item.id, name), () => setEditing(false));
          }}
        >
          <div className="md:w-80">
            <FormField label={renameLabel}>
              <Input value={name} onChange={(e) => setName(e.target.value)} required maxLength={200} autoFocus />
            </FormField>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" busy={busy}>
              Save
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setEditing(false)}>
              Close
            </Button>
          </div>
        </form>
      ) : (
        <>
          <ItemText item={item} />
          <div className="flex shrink-0 flex-wrap gap-2">
            {onRename ? (
              <Button size="sm" variant="secondary" aria-label={`Rename ${item.name}`} onClick={() => setEditing(true)}>
                Rename
              </Button>
            ) : null}
            {onActive ? (
              <Button size="sm" variant="secondary" busy={busy} aria-label={`${item.active ? "Turn off" : "Turn on"} ${item.name}`} onClick={() => run(() => onActive(item.id, !item.active))}>
                {item.active ? "Turn off" : "Turn on"}
              </Button>
            ) : null}
          </div>
        </>
      )}
    </li>
  );
}

/** A list of named things that are renamed and turned off, never deleted. */
export function ListEditor({
  items,
  empty,
  onRename,
  onActive,
  renameLabel = "New name",
}: Readonly<{
  items: ListItem[];
  empty: { title: string; text: string };
  onRename?: (id: string, name: string) => Promise<ActionResult>;
  onActive?: (id: string, active: boolean) => Promise<ActionResult>;
  renameLabel?: string;
}>) {
  if (!items.length)
    return (
      <Card pad={false}>
        <EmptyState title={empty.title}>{empty.text}</EmptyState>
      </Card>
    );
  return (
    <Card pad={false} as="div">
      <ul className="m-0 list-none divide-y divide-divider p-0">
        {items.map((i) => (
          <ItemRow key={`${i.id}-${i.name}-${i.active}`} item={i} onRename={onRename} onActive={onActive} renameLabel={renameLabel} />
        ))}
      </ul>
    </Card>
  );
}
