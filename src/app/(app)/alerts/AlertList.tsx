"use client";

import Link from "next/link";
import { Button } from "@/ui/components/Button";
import { markAlertsReadAction } from "../_personnel/actions";
import { ActionStatus, useAction } from "../_personnel/use-action";

type Row = { id: string; title: string; body: string | null; link: string | null; when: string; read: boolean };

/** Alerts with "Mark all read"; opening one (or Mark read) marks it read. */
export function AlertList({ alerts, unread }: Readonly<{ alerts: Row[]; unread: number }>) {
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-2.5">
      {unread > 0 ? (
        <Button variant="secondary" size="sm" className="w-fit" busy={busy} onClick={() => run(() => markAlertsReadAction("all"))}>
          Mark all read
        </Button>
      ) : null}
      <ActionStatus result={result} />
      <ul className="m-0 flex list-none flex-col divide-y divide-divider overflow-hidden rounded-xl border border-line bg-surface p-0 md:rounded-2xl">
        {alerts.map((a) => (
          <li key={a.id} className="flex items-start gap-3 px-4 py-3">
            <span aria-hidden className={`mt-1.5 size-2.5 shrink-0 rounded-full ${a.read ? "bg-transparent" : "bg-attention-dot"}`} />
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="flex items-baseline justify-between gap-2">
                {a.link ? (
                  <Link href={a.link} onClick={() => (a.read ? undefined : void markAlertsReadAction([a.id]))} className={a.read ? "font-medium" : "font-bold"}>
                    {a.read ? null : <span className="sr-only">Unread. </span>}
                    {a.title}
                  </Link>
                ) : (
                  <span className={a.read ? "font-medium" : "font-bold"}>
                    {a.read ? null : <span className="sr-only">Unread. </span>}
                    {a.title}
                  </span>
                )}
                <span className="shrink-0 text-xs text-muted">{a.when}</span>
              </span>
              {a.body ? <span className="text-sm text-muted">{a.body}</span> : null}
              {!a.read ? (
                <button type="button" disabled={busy} onClick={() => run(() => markAlertsReadAction([a.id]))} aria-label={`Mark read: ${a.title}`} className="inline-flex min-h-9 w-fit items-center text-sm font-semibold text-link hover:underline disabled:opacity-55 pointer-coarse:min-h-11">
                  Mark read
                </button>
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
