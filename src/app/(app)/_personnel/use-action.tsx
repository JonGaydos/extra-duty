"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Notice } from "@/ui/components/Notice";
import type { ActionResult } from "./result";

/**
 * Calls a server action, keeps its result for the status line and refreshes the page's server data when it
 * worked. `busy` is true while it runs.
 */
export function useAction() {
  const router = useRouter();
  const [result, setResult] = useState<ActionResult | null>(null);
  const [busy, start] = useTransition();
  const run = (call: () => Promise<ActionResult>, onOk?: (r: ActionResult & { ok: true }) => void, refresh = true) =>
    start(async () => {
      try {
        const r = await call();
        setResult(r);
        if (r.ok) {
          onOk?.(r);
          if (refresh) router.refresh();
        }
      } catch {
        setResult({ ok: false, error: "That did not go through. Check your connection and try again." });
      }
    });
  return { run, busy, result, clear: () => setResult(null) };
}

/** An always-present live region, so each new result is announced. */
export function ActionStatus({ result, success }: { result: ActionResult | null; success?: string }) {
  const text = result ? (result.ok ? (result.message ?? success) : result.error) : undefined;
  return (
    <div role="status" aria-live="polite" className="empty:hidden">
      {text ? (
        <Notice tone={result?.ok ? "success" : "danger"} as="div">
          {text}
        </Notice>
      ) : null}
    </div>
  );
}
