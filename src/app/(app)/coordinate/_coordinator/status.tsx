"use client";

import { useRouter } from "next/navigation";
import { createContext, useCallback, useContext, useState, useTransition } from "react";
import { Notice } from "@/ui/components/Notice";
import type { ActionResult } from "../../_personnel/result";

type Report = (r: ActionResult | null) => void;
const StatusContext = createContext<Report | null>(null);

/** A result's message when done, its error when not; nothing before the first result. */
function statusText(result: ActionResult | null): string | undefined {
  if (!result) return undefined;
  return result.ok ? result.message : result.error;
}

/**
 * One announced status line for a whole coordinator screen. Rows on the to-do list disappear once they are
 * handled, so a result cannot live inside the row; it lives here, floating just above the tab bar, until the next
 * action or Dismiss.
 */
export function StatusProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [result, setResult] = useState<ActionResult | null>(null);
  const text = statusText(result);
  return (
    <StatusContext.Provider value={setResult}>
      {children}
      <output
        aria-live="polite"
        className="pointer-events-none fixed inset-x-0 bottom-[calc(80px+env(safe-area-inset-bottom))] z-40 flex justify-center px-4 empty:hidden md:bottom-6"
      >
        {text ? (
          <div className="pointer-events-auto flex w-full max-w-130 items-start gap-2 rounded-md border border-line bg-surface p-1 shadow-float">
            <div className="min-w-0 flex-1">
              <Notice tone={result?.ok ? "success" : "danger"} as="div">
                {text}
              </Notice>
            </div>
            <button
              type="button"
              onClick={() => setResult(null)}
              className="min-h-10 shrink-0 rounded-sm px-3 text-sm font-semibold text-link hover:bg-subtle pointer-coarse:min-h-11"
            >
              Dismiss
            </button>
          </div>
        ) : null}
      </output>
    </StatusContext.Provider>
  );
}

/**
 * Runs a server action, reports the result to the screen's status line and refreshes the server data when it
 * worked. `busy` is true while it runs; `error` keeps the last failure for inline display.
 */
export function useCoordAction() {
  const report = useContext(StatusContext);
  const router = useRouter();
  const [busy, start] = useTransition();
  const [error, setError] = useState<ActionResult | null>(null);
  const run = useCallback(
    (call: () => Promise<ActionResult>, onOk?: (r: ActionResult & { ok: true }) => void, opts: { refresh?: boolean; quiet?: boolean } = {}) =>
      start(async () => {
        let r: ActionResult;
        try {
          r = await call();
        } catch (e) {
          // forbidden() in a server action arrives as a rejected call with a 403 digest.
          const digest = (e as { digest?: unknown } | null)?.digest;
          r = typeof digest === "string" && digest.endsWith(";403")
            ? { ok: false, error: "Only admins can do that." }
            : { ok: false, error: "That did not go through. Check your connection and try again." };
        }
        setError(r.ok ? null : r);
        if (!opts.quiet || !r.ok) report?.(r);
        if (r.ok) {
          onOk?.(r);
          if (opts.refresh !== false) router.refresh();
        }
      }),
    [report, router],
  );
  return { run, busy, error };
}
