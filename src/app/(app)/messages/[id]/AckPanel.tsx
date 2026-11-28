"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/ui/components/Button";
import { Notice } from "@/ui/components/Notice";
import { acknowledgeMessageAction, remindAckAction } from "../../_personnel/actions";
import { ActionStatus, useAction } from "../../_personnel/use-action";

/**
 * The end of a message that requires acknowledgement. "I have read and understand" stays disabled until this marker,
 * placed after the message, has been on screen: the person scrolled to the end, or the whole message fits. Pressing
 * it records the time, which is final.
 */
export function AckPanel({ id, acknowledgedText, due }: Readonly<{ id: string; acknowledgedText: string | null; due: string | null }>) {
  const end = useRef<HTMLDivElement>(null);
  const [reachedEnd, setReachedEnd] = useState(false);
  const { run, busy, result } = useAction();

  useEffect(() => {
    if (acknowledgedText || reachedEnd) return;
    const el = end.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      setReachedEnd(true);
      return;
    }
    const seen = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setReachedEnd(true);
        seen.disconnect();
      }
    });
    seen.observe(el);
    return () => seen.disconnect();
  }, [acknowledgedText, reachedEnd]);

  if (acknowledgedText) {
    return (
      <Notice tone="success" as="div">
        {acknowledgedText}
      </Notice>
    );
  }
  return (
    <div ref={end} data-testid="ack-panel" className="flex flex-col gap-2.5 border-t border-divider pt-3">
      <p className="m-0 text-sm font-semibold">This message requires your acknowledgement{due ? `, due ${due}` : ""}.</p>
      <p id={`ack-hint-${id}`} className="m-0 text-sm text-muted">
        {reachedEnd ? "Acknowledging records the time. It cannot be undone." : "Read to the end of the message to acknowledge it."}
      </p>
      <Button size="lg" busy={busy} disabled={!reachedEnd} aria-describedby={`ack-hint-${id}`} className="md:w-fit" onClick={() => run(() => acknowledgeMessageAction(id))}>
        I have read and understand
      </Button>
      <ActionStatus result={result} />
    </div>
  );
}

/** Staff: "Remind those who haven't", through the normal notification path. */
export function RemindButton({ id, pending }: Readonly<{ id: string; pending: number }>) {
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-2">
      <Button variant="secondary" size="sm" busy={busy} disabled={pending === 0} className="w-fit" onClick={() => run(() => remindAckAction(id))}>
        Remind those who haven&apos;t
      </Button>
      <ActionStatus result={result} />
    </div>
  );
}
