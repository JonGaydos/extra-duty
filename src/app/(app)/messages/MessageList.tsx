"use client";

import Link from "next/link";
import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { hideMessagesAction, markMessagesAction } from "../_personnel/actions";
import { ActionStatus, useAction } from "../_personnel/use-action";

export type MessageRowView = { id: string; who: string; initials: string; when: string; subject: string; snippet: string; unread: boolean; tag: string | null };

/** Messages with checkboxes; the chosen ones can be marked read or unread, or deleted from this inbox. */
export function MessageList({ rows, selectable }: { rows: MessageRowView[]; selectable: boolean }) {
  const [chosen, setChosen] = useState<string[]>([]);
  const { run, busy, result } = useAction();
  const toggle = (id: string) => setChosen((c) => (c.includes(id) ? c.filter((x) => x !== id) : [...c, id]));
  return (
    <div className="flex flex-col gap-2.5">
      {selectable ? (
        <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Chosen messages">
          <span className="text-sm text-muted">{chosen.length ? `${chosen.length} chosen` : "Choose messages to mark or delete them"}</span>
          {chosen.length ? (
            <>
          <Button size="sm" variant="secondary" disabled={!chosen.length} busy={busy} onClick={() => run(() => markMessagesAction(chosen, true), () => setChosen([]))}>
            Mark read
          </Button>
          <Button size="sm" variant="secondary" disabled={!chosen.length} busy={busy} onClick={() => run(() => markMessagesAction(chosen, false), () => setChosen([]))}>
            Mark unread
          </Button>
          <Button size="sm" variant="secondary" disabled={!chosen.length} busy={busy} onClick={() => run(() => hideMessagesAction(chosen), () => setChosen([]))}>
            Delete
          </Button>
            </>
          ) : null}
        </div>
      ) : null}
      <ActionStatus result={result} />
      <ul className="m-0 flex list-none flex-col divide-y divide-divider overflow-hidden rounded-xl border border-line bg-surface p-0 md:rounded-2xl">
        {rows.map((r) => (
          <li key={r.id} className="flex items-start gap-3 px-4 py-3">
            {selectable ? (
              <label className="-m-2.5 flex size-11 shrink-0 items-center justify-center">
                <input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r.id)} className="size-4.5 accent-accent" aria-label={`Choose message: ${r.subject}`} />
              </label>
            ) : null}
            <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-xs font-bold text-link">
              {r.initials}
            </span>
            <Link href={`/messages/${r.id}`} data-card-link className="group flex min-w-0 flex-1 flex-col gap-0.5 text-ink no-underline hover:text-ink">
              <span className="flex items-baseline justify-between gap-2">
                <span className={`underline decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2 ${r.unread ? "font-bold" : "font-medium"}`}>
                  {r.unread ? <span className="sr-only">Unread. </span> : null}
                  {r.who}
                </span>
                <span className="shrink-0 text-xs text-muted">{r.when}</span>
              </span>
              <span className={`truncate ${r.unread ? "font-semibold" : ""}`}>{r.subject}</span>
              <span className="line-clamp-2 text-sm text-muted">{r.snippet}</span>
              {r.tag ? <span className="text-xs font-semibold text-muted">{r.tag}</span> : null}
            </Link>
            {r.unread ? <span aria-hidden className="mt-2 size-2.5 shrink-0 rounded-full bg-attention-dot" /> : null}
          </li>
        ))}
      </ul>
    </div>
  );
}
