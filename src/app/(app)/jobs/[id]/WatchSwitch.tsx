"use client";

import { useState } from "react";
import { watchAction } from "../../_personnel/actions";
import { ActionStatus, useAction } from "../../_personnel/use-action";

/** "Alert me if it opens": a switch on a full or unreleased detail. */
export function WatchSwitch({ jobId, watching }: Readonly<{ jobId: string; watching: boolean }>) {
  const [on, setOn] = useState(watching);
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <span id="watch-label" className="font-medium">
          Alert me if it opens
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={on}
          aria-labelledby="watch-label"
          disabled={busy}
          onClick={() => {
            const next = !on;
            run(() => watchAction({ jobId, on: next }), () => setOn(next));
          }}
          className="flex h-11 items-center disabled:opacity-55"
        >
          <span className={`relative inline-flex h-4.5 w-7.5 rounded-full transition-colors duration-150 ${on ? "bg-accent" : "bg-field"}`}>
            <span className={`absolute top-0.5 size-3.5 rounded-full bg-surface transition-[left] duration-150 ${on ? "left-3.5" : "left-0.5"}`} />
          </span>
        </button>
      </div>
      <ActionStatus result={result} />
    </div>
  );
}
