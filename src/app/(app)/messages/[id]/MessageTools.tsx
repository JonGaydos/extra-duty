"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef } from "react";
import { Button, ButtonLink } from "@/ui/components/Button";
import { hideMessagesAction, markMessagesAction } from "../../_personnel/actions";
import { ActionStatus, useAction } from "../../_personnel/use-action";

/** Marks the message read when opened (recipients only), and offers Reply, Mark unread and Delete. */
export function MessageTools({ id, recipient }: Readonly<{ id: string; recipient: boolean }>) {
  const router = useRouter();
  const opened = useRef(false);
  const { run, busy, result } = useAction();
  useEffect(() => {
    if (!recipient || opened.current) return;
    opened.current = true;
    void markMessagesAction([id], true).catch(() => undefined);
  }, [id, recipient]);
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap gap-2">
        <ButtonLink href={`/messages/new?replyTo=${id}`}>Reply</ButtonLink>
        {recipient ? (
          <>
            <Button variant="secondary" busy={busy} onClick={() => run(() => markMessagesAction([id], false), () => router.push("/messages"), false)}>
              Mark unread
            </Button>
            <Button variant="secondary" busy={busy} onClick={() => run(() => hideMessagesAction([id]), () => router.push("/messages"), false)}>
              Delete
            </Button>
          </>
        ) : null}
      </div>
      <ActionStatus result={result} />
    </div>
  );
}
