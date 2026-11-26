"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { approveInvoiceAction, sendApprovedInvoiceAction, cancelDetailAction, decideFlagAction, liftLockAction, reviewNoteAction } from "./_coordinator/actions";
import { useCoordAction } from "./_coordinator/status";
import { ApproveChoice } from "../invoices/[id]/StaffInvoiceActions";

/** One-tap cancel for a locked detail that has started, with the reason already filled in. */
export function LockedCancel({ jobId, title, reason, latePay, signedUp }: Readonly<{ jobId: string; title: string; reason: string; latePay: boolean; signedUp: number }>) {
  const [why, setWhy] = useState(reason);
  const [applyPay, setApplyPay] = useState(false);
  const { run, busy } = useCoordAction();
  return (
    <form
      className="flex w-full flex-col gap-2.5 md:w-80"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => cancelDetailAction({ jobId, reason: why, cause: "vendor_hold", applyLateCancelPay: latePay || applyPay }));
      }}
    >
      <FormField label="Reason">
        <Input value={why} onChange={(e) => setWhy(e.target.value)} required maxLength={500} />
      </FormField>
      {!latePay && signedUp > 0 ? (
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" checked={applyPay} onChange={(e) => setApplyPay(e.target.checked)} className="size-4.5 accent-accent" />Pay the people signed up the late cancellation minimum
        </label>
      ) : null}
      <Button type="submit" variant="danger" busy={busy} aria-label={`Cancel detail, ${title}`}>
        Cancel detail
      </Button>
    </form>
  );
}

export function ApproveInvoiceButton({ invoiceId, batched = false, sendByDefault = true }: Readonly<{ invoiceId: string; batched?: boolean; sendByDefault?: boolean }>) {
  const { run, busy } = useCoordAction();
  return <ApproveChoice size="sm" busy={busy} batched={batched} sendByDefault={sendByDefault} onApprove={(send) => run(() => approveInvoiceAction(invoiceId, { send }))} />;
}

/** "Send now" for an invoice approved without sending. */
export function SendNowButton({ invoiceId, number }: Readonly<{ invoiceId: string; number: string }>) {
  const { run, busy } = useCoordAction();
  return (
    <Button size="sm" variant="secondary" busy={busy} onClick={() => run(() => sendApprovedInvoiceAction(invoiceId))} aria-label={`Send now, ${number}`}>
      Send now
    </Button>
  );
}

/** Approve as written, edit then approve, or deny with an optional reason. */
export function NoteReview({ noteId, body }: Readonly<{ noteId: string; body: string }>) {
  const [mode, setMode] = useState<"idle" | "edit" | "deny">("idle");
  const [text, setText] = useState(body);
  const [comment, setComment] = useState("");
  const { run, busy } = useCoordAction();
  if (mode === "edit")
    return (
      <form
        className="flex w-full flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => reviewNoteAction({ noteId, decision: "approve", editedBody: text }));
        }}
      >
        <FormField label="Note as deputies will see it">
          <TextArea value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} required />
        </FormField>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" busy={busy}>
            Approve with changes
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setMode("idle")}>
            Back
          </Button>
        </div>
      </form>
    );
  if (mode === "deny")
    return (
      <form
        className="flex w-full flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => reviewNoteAction({ noteId, decision: "deny", comment }));
        }}
      >
        <FormField label="Reason for the author" hint="Optional">
          <Input value={comment} onChange={(e) => setComment(e.target.value)} maxLength={2000} />
        </FormField>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" size="sm" variant="danger" busy={busy}>
            Deny note
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setMode("idle")}>
            Back
          </Button>
        </div>
      </form>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" busy={busy} onClick={() => run(() => reviewNoteAction({ noteId, decision: "approve" }))}>
        Approve
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setMode("edit")}>
        Edit
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setMode("deny")}>
        Deny
      </Button>
    </div>
  );
}

export function FlagDecision({ requestId, who }: Readonly<{ requestId: string; who: string }>) {
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState("");
  const { run, busy } = useCoordAction();
  if (denying)
    return (
      <form
        className="flex w-full flex-col gap-2.5"
        onSubmit={(e) => {
          e.preventDefault();
          run(() => decideFlagAction({ requestId, approve: false, reason }));
        }}
      >
        <FormField label="Reason" hint="Optional">
          <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
        </FormField>
        <div className="flex gap-2">
          <Button type="submit" size="sm" variant="danger" busy={busy}>
            Deny request
          </Button>
          <Button type="button" size="sm" variant="secondary" onClick={() => setDenying(false)}>
            Back
          </Button>
        </div>
      </form>
    );
  return (
    <div className="flex flex-wrap gap-2">
      <Button size="sm" busy={busy} onClick={() => run(() => decideFlagAction({ requestId, approve: true, reason: "" }))} aria-label={`Grant, ${who}`}>
        Grant
      </Button>
      <Button size="sm" variant="secondary" onClick={() => setDenying(true)} aria-label={`Deny, ${who}`}>
        Deny
      </Button>
    </div>
  );
}

/** Lifts one person's sign-up lock for a few days, with a reason they are told. */
export function LiftLock({ userId, name }: Readonly<{ userId: string; name: string }>) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [days, setDays] = useState("3");
  const { run, busy } = useCoordAction();
  if (!open)
    return (
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)} aria-label={`Lift lock, ${name}`}>
        Lift lock
      </Button>
    );
  return (
    <form
      className="flex w-full flex-col gap-2.5 md:w-80"
      onSubmit={(e) => {
        e.preventDefault();
        run(() => liftLockAction({ userId, days: Number(days), reason }));
      }}
    >
      <FormField label="Reason">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} required maxLength={500} />
      </FormField>
      <FormField label="For" hint="Ends at midnight after the last day.">
        <Select value={days} onChange={(e) => setDays(e.target.value)}>
          {[1, 3, 7, 14, 30].map((d) => (
            <option key={d} value={d}>
              {d === 1 ? "1 day" : `${d} days`}
            </option>
          ))}
        </Select>
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" size="sm" busy={busy}>
          Lift lock
        </Button>
        <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(false)}>
          Back
        </Button>
      </div>
    </form>
  );
}
