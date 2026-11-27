"use client";

import { useId, useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { useCoordAction } from "../../coordinate/_coordinator/status";
import { reviewW9Action } from "../_admin/actions";

const REJECT_REASONS = ["Line 2 missing", "Not signed", "Not dated", "Wrong taxpayer ID number", "Old form revision", "Hard to read"];

/**
 * Approve or reject a pending W-9. Approving records the signature date and the IRS form revision (a short list, or
 * typed); rejecting needs a reason, which the person sees with a link to upload again.
 */
export function W9Review({ w9Id, name, today, revisions }: Readonly<{ w9Id: string; name: string; today: string; revisions: readonly string[] }>) {
  const id = useId();
  const [mode, setMode] = useState<"approve" | "reject" | null>(null);
  const [signedOn, setSignedOn] = useState("");
  const [formRevision, setFormRevision] = useState(revisions[0] ?? "");
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();

  if (mode === null)
    return (
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => setMode("approve")}>Approve</Button>
        <Button variant="secondary" onClick={() => setMode("reject")}>
          Reject
        </Button>
      </div>
    );

  if (mode === "approve")
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => reviewW9Action({ w9Id, decision: "approve", signedOn, formRevision }), () => setMode(null));
        }}
      >
        <div className="grid gap-3 md:grid-cols-2">
          <FormField label="Signature date" hint="The date on the signature line.">
            <Input type="date" value={signedOn} max={today} onChange={(e) => setSignedOn(e.target.value)} required />
          </FormField>
          <FormField label="IRS form revision" hint="Top left of the form, under Form W-9.">
            <Input value={formRevision} onChange={(e) => setFormRevision(e.target.value)} list={`${id}-revisions`} required maxLength={40} autoComplete="off" />
          </FormField>
        </div>
        <datalist id={`${id}-revisions`}>
          {revisions.map((r) => (
            <option key={r} value={r} />
          ))}
        </datalist>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" busy={busy}>
            Approve W-9
          </Button>
          <Button type="button" variant="secondary" onClick={() => setMode(null)}>
            Back
          </Button>
        </div>
      </form>
    );

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => reviewW9Action({ w9Id, decision: "reject", reason }), () => setMode(null));
      }}
    >
      <FormField label="Reason" hint={`${name} sees this with a link to upload a new W-9.`}>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} list={`${id}-reasons`} required maxLength={500} autoComplete="off" placeholder="Line 2 missing" />
      </FormField>
      <datalist id={`${id}-reasons`}>
        {REJECT_REASONS.map((r) => (
          <option key={r} value={r} />
        ))}
      </datalist>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant="danger" busy={busy}>
          Reject W-9
        </Button>
        <Button type="button" variant="secondary" onClick={() => setMode(null)}>
          Back
        </Button>
      </div>
    </form>
  );
}
