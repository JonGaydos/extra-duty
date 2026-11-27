"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { DetailRowBody, type RowView } from "../../_personnel/JobRow";
import { BulkEdit } from "./EditPanel";

export type SelectableItem = RowView & {
  /** The row's key when one detail can show twice (a canceled sign-up of the viewer's); the id otherwise. */
  key?: string;
  /** Why bulk edit cannot change this detail (canceled, declined or started), shown on the row; null when it can. */
  blocked: string | null;
  /** False for a row that is only listed (the viewer's own canceled sign-up): no checkbox and no note. */
  selectable?: boolean;
  /** More chips or controls after the row's chips (the viewer's own Hide vendor, a sign-up's end reason). */
  extra?: React.ReactNode;
};

/**
 * Detail rows in the shared Details look, each with a checkbox for staff, and Edit selected for a bulk edit across
 * any vendors.
 */
export function SelectableDetails({ items, types, defaultTypeId }: Readonly<{ items: SelectableItem[]; types: Array<{ id: string; name: string }>; defaultTypeId: string }>) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const editable = items.filter((i) => !i.blocked && i.selectable !== false);
  const ids = [...picked].filter((id) => editable.some((i) => i.id === id));
  const all = editable.length > 0 && ids.length === editable.length;
  const toggle = (id: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  return (
    <div className="flex flex-col gap-2.5">
      {editable.length ? (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <label className="flex min-h-11 items-center gap-2 text-sm">
            <input type="checkbox" className="size-4.5 accent-accent" checked={all} onChange={() => setPicked(all ? new Set() : new Set(editable.map((i) => i.id)))} />Select all shown that can change
          </label>
          <span className="flex items-center gap-2">
            <output className="text-sm text-muted" data-numeric>
              {ids.length ? `${ids.length} selected` : ""}
            </output>
            <Button size="sm" disabled={ids.length === 0} onClick={() => setEditing(true)} aria-expanded={editing}>
              Edit selected
            </Button>
          </span>
        </div>
      ) : null}
      {editing && ids.length ? (
        <Card tone="accent" as="div">
          <CardTitle>{ids.length === 1 ? "Edit 1 detail" : `Edit ${ids.length} details`}</CardTitle>
          <BulkEdit
            key={ids.join(",")}
            jobIds={ids}
            types={types}
            defaultTypeId={defaultTypeId}
            onDone={() => {
              setEditing(false);
            }}
          />
        </Card>
      ) : null}
      <Card pad={false} as="div">
        <ul className="m-0 list-none divide-y divide-divider p-0" aria-label="Details">
          {items.map((j) => (
            <li key={j.key ?? j.id} className="flex gap-3 px-4 py-3.25">
              {!j.blocked && j.selectable !== false ? (
                <label className="-my-2.5 -ml-3 flex size-11 shrink-0 cursor-pointer items-center justify-center">
                  <input type="checkbox" className="size-4.5 accent-accent" checked={picked.has(j.id)} onChange={() => toggle(j.id)} aria-label={`Select ${j.sub}`} />
                </label>
              ) : (
                <span className="-my-2.5 -ml-3 size-11 shrink-0" aria-hidden />
              )}
              <DetailRowBody row={j} extra={j.extra} note={j.selectable === false ? null : j.blocked} />
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
