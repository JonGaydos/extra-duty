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

/** An upload's own outcome ({ ok, text }) in the shape the status line reads. */
export function uploadResult(msg: { ok: boolean; text: string } | null): ActionResult | null {
  if (!msg) return null;
  return msg.ok ? { ok: true, message: msg.text } : { ok: false, error: msg.text };
}

/** The message to show for a result: its own message (or `success`) when done, the error when not. */
function resultText(result: ActionResult | null, success: string | undefined): string | undefined {
  if (!result) return undefined;
  return result.ok ? (result.message ?? success) : result.error;
}

/** An always-present live region, so each new result is announced. */
export function ActionStatus({ result, success }: Readonly<{ result: ActionResult | null; success?: string }>) {
  const text = resultText(result, success);
  return (
    <output aria-live="polite" className="block empty:hidden">
      {text ? (
        <Notice tone={result?.ok ? "success" : "danger"} as="div">
          {text}
        </Notice>
      ) : null}
    </output>
  );
}
