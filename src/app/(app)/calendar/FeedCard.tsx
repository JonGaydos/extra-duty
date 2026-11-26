"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { revokeFeedAction, rotateFeedAction } from "../_personnel/actions";
import { ActionStatus, useAction } from "../_personnel/use-action";

/** Whether a link is active, since when, and when a calendar app last read it. */
function FeedState({ active, since, lastUsed }: Readonly<{ active: boolean; since: string | null; lastUsed: string | null }>) {
  if (!active) return <p className="m-0 text-sm">No calendar link is active.</p>;
  return (
    <p className="m-0 text-sm">
      A link is active{since ? ` since ${since}` : ""}.{lastUsed ? ` Last read by a calendar app ${lastUsed}.` : " No calendar app has read it yet."}
    </p>
  );
}

/**
 * The personal calendar feed. The link is shown once, right after it is made (only a hash is kept); making a
 * new one ends the old one, and turning it off stops every app subscribed to it.
 */
export function FeedCard({ origin, active, since, lastUsed }: Readonly<{ origin: string; active: boolean; since: string | null; lastUsed: string | null }>) {
  const [url, setUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-3">
      <p className="m-0 max-w-[65ch] text-sm text-muted">
        Subscribe from Outlook, Google or Apple Calendar to see your sign-ups, pending shorter shifts and backup places. The link shows only your own details. Anyone with the link can read it, so keep it private.
      </p>
      {url ? (
        <div className="flex flex-col gap-2">
          <FormField label="Your calendar link" hint="Copy it now. For your privacy it is not shown again.">
            <Input readOnly value={url} onFocus={(e) => e.currentTarget.select()} />
          </FormField>
          <Button
            variant="secondary"
            className="w-fit"
            onClick={() => {
              void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => setCopied(false));
            }}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      ) : (
        <FeedState active={active} since={since} lastUsed={lastUsed} />
      )}
      <div className="flex flex-wrap gap-2">
        <Button busy={busy} onClick={() => run(() => rotateFeedAction(), (r) => r.value && setUrl(`${origin}/api/v1/calendar.ics?token=${encodeURIComponent(r.value)}`))}>
          {active || url ? "Make a new link" : "Make calendar link"}
        </Button>
        {active || url ? (
          <Button variant="secondary" busy={busy} onClick={() => run(() => revokeFeedAction(), () => setUrl(null))}>
            Turn off link
          </Button>
        ) : null}
      </div>
      <ActionStatus result={result} />
    </div>
  );
}
