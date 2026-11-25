"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, TextArea } from "@/ui/components/FormField";
import { addDeputyNoteAction } from "../../_personnel/actions";
import { ActionStatus, useAction } from "../../_personnel/use-action";

/** "Add a note for future deputies": opens an inline form; a coordinator reviews the note before others see it. */
export function DeputyNoteForm({ jobId, hasLocation, max }: { jobId: string; hasLocation: boolean; max: number }) {
  const [open, setOpen] = useState(false);
  const [body, setBody] = useState("");
  const [scope, setScope] = useState<"vendor" | "location">(hasLocation ? "location" : "vendor");
  const { run, busy, result } = useAction();
  if (!open) {
    return (
      <div className="flex flex-col gap-2">
        <Button variant="secondary" className="w-fit" onClick={() => setOpen(true)} aria-expanded={false}>
          Add a note for future deputies
        </Button>
        <ActionStatus result={result} />
      </div>
    );
  }
  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => addDeputyNoteAction({ jobId, body, scope }), () => {
          setBody("");
          setOpen(false);
        });
      }}
    >
      <FormField label="Note for future deputies" hint="Parking, check-in, what to bring. No personal details.">
        <TextArea value={body} onChange={(e) => setBody(e.target.value)} maxLength={max} required />
      </FormField>
      {hasLocation ? (
        <fieldset className="m-0 flex flex-wrap gap-4 border-0 p-0">
          <legend className="mb-1.5 text-sm font-medium text-muted">Applies to</legend>
          {(["location", "vendor"] as const).map((v) => (
            <label key={v} className="flex min-h-11 items-center gap-2">
              <input type="radio" name="note-scope" value={v} checked={scope === v} onChange={() => setScope(v)} className="size-4.5 accent-accent" />
              {v === "location" ? "This location" : "Every detail for this vendor"}
            </label>
          ))}
        </fieldset>
      ) : null}
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Send for review
        </Button>
        <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
      <ActionStatus result={result} />
    </form>
  );
}
