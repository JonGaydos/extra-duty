"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { decideReviewItemAction, startReviewAction } from "../_admin/actions";

export function StartReview() {
  const { run, busy } = useCoordAction();
  return (
    <Button busy={busy} onClick={() => run(() => startReviewAction())} className="w-full md:w-fit">
      Start access review
    </Button>
  );
}

/**
 * Keep, needs change (with a note) or turn off one account. Turning off is the same departure flow as on the
 * person's page: it asks for the last day, and the reason is "Access review".
 */
export function DecideItem({ itemId, name, canDeactivate, today }: Readonly<{ itemId: string; name: string; canDeactivate: boolean; today: string }>) {
  const [mode, setMode] = useState<"idle" | "change" | "deactivate">("idle");
  const [note, setNote] = useState("");
  const [lastDay, setLastDay] = useState(today);
  const { run, busy } = useCoordAction();
  if (mode === "change")
    return (
      <form
        className="flex w-full flex-col gap-2 md:w-80"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => decideReviewItemAction({ itemId, decision: "change", note }));
        }}
      >
        <FormField label="What needs to change">
          <Input value={note} onChange={(e) => setNote(e.target.value)} required maxLength={500} autoFocus />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" busy={busy}>
            Record change
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setMode("idle")}>
            Close
          </Button>
        </div>
      </form>
    );
  if (mode === "deactivate")
    return (
      <form
        className="flex w-full flex-col gap-2 rounded-md border border-danger-line bg-danger-soft p-3 md:w-80"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => decideReviewItemAction({ itemId, decision: "deactivate", note: "", lastDay }));
        }}
      >
        <p className="m-0 text-sm text-danger-ink">Turn off {name}&apos;s account? They are signed out and cannot sign in. Their sign-ups after the last day are removed.</p>
        <FormField label="Last day" hint="Today or earlier.">
          <Input type="date" value={lastDay} max={today} onChange={(e) => setLastDay(e.target.value)} required />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="danger" busy={busy}>
            Turn off account
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setMode("idle")}>
            Close
          </Button>
        </div>
      </form>
    );
  return (
    <>
      <Button size="sm" busy={busy} aria-label={`Keep ${name}`} onClick={() => run(() => decideReviewItemAction({ itemId, decision: "keep", note: "" }))}>
        Keep
      </Button>
      <Button size="sm" variant="secondary" aria-label={`Needs change: ${name}`} onClick={() => setMode("change")}>
        Needs change
      </Button>
      {canDeactivate ? (
        <Button size="sm" variant="secondary" aria-label={`Turn off ${name}`} onClick={() => setMode("deactivate")}>
          Turn off
        </Button>
      ) : null}
    </>
  );
}
