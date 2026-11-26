"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { PayLabel } from "@/ui/components/PayLabel";
import { BulkEdit } from "./EditPanel";

export type SelectableItem = {
  id: string;
  href: string;
  title: string;
  meta: string;
  pay: { totalCents: number; rateCents: number; maxTotalCents: number; maxRateCents: number };
  chips: Array<{ tone: "success" | "warning" | "danger" | "attention" | "info" | "neutral" | "coordinator"; text: string }>;
  /** Why bulk edit cannot change this detail (canceled, declined or started), shown on the row; null when it can. */
  blocked: string | null;
};

/** The coordinator's detail rows with a checkbox each, and Edit selected for a bulk edit across any vendors. */
export function SelectableDetails({ items, types, defaultTypeId }: Readonly<{ items: SelectableItem[]; types: Array<{ id: string; name: string }>; defaultTypeId: string }>) {
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState(false);
  const editable = items.filter((i) => !i.blocked);
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
            <li key={j.id} className="flex gap-3 px-4 py-3.25">
              {!j.blocked ? (
                <label className="-my-2.5 -ml-3 flex size-11 shrink-0 cursor-pointer items-center justify-center">
                  <input type="checkbox" className="size-4.5 accent-accent" checked={picked.has(j.id)} onChange={() => toggle(j.id)} aria-label={`Select ${j.title}`} />
                </label>
              ) : (
                <span className="-my-2.5 -ml-3 size-11 shrink-0" aria-hidden />
              )}
              <div className="flex min-w-0 flex-1 flex-col gap-2.5 md:flex-row md:items-start md:justify-between md:gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="m-0 font-semibold">
                    <Link href={j.href} className="text-ink hover:text-link">
                      {j.title}
                    </Link>
                  </p>
                  <div className="text-sm text-muted">{j.meta}</div>
                  {j.blocked ? <div className="text-xs font-medium text-muted">Not editable: {j.blocked}</div> : null}
                </div>
                <div className="flex shrink-0 flex-wrap items-start gap-2">
                  <PayLabel totalCents={j.pay.totalCents} rateCents={j.pay.rateCents} upTo={{ totalCents: j.pay.maxTotalCents, rateCents: j.pay.maxRateCents }} />
                  {j.chips.map((c) => (
                    <Chip key={c.text} tone={c.tone}>
                      {c.text}
                    </Chip>
                  ))}
                </div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </div>
  );
}
