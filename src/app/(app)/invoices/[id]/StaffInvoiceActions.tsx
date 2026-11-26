"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { Check } from "../../admin/_admin/forms";
import {
  approveInvoiceAction,
  closeInvoiceAction,
  closeIssueAction,
  editInvoiceAction,
  issueNoteAction,
  issueWaitingOnAction,
  sendApprovedInvoiceAction,
  resendInvoiceAction,
  sendBackInvoiceAction,
} from "../../coordinate/_coordinator/actions";
import { useCoordAction } from "../../coordinate/_coordinator/status";

/**
 * The approve step: "Approve and send" and "Approve, don't send". The vendor's setting decides which is the
 * primary button and comes first; either can be chosen for this invoice.
 */
export function ApproveChoice({ busy, batched, sendByDefault, onApprove, size }: Readonly<{ busy: boolean; batched: boolean; sendByDefault: boolean; onApprove: (send: boolean) => void; size?: "sm" }>) {
  const send = (
    <Button key="send" size={size} variant={sendByDefault ? "primary" : "secondary"} busy={busy} onClick={() => onApprove(true)}>
      {batched ? "Approve for the next send" : "Approve and send"}
    </Button>
  );
  const hold = (
    <Button key="hold" size={size} variant={sendByDefault ? "secondary" : "primary"} busy={busy} onClick={() => onApprove(false)}>
      Approve, don&apos;t send
    </Button>
  );
  return <>{sendByDefault ? [send, hold] : [hold, send]}</>;
}

type Mode = "edit" | "back" | "close" | "waiting" | "note" | "closeIssue" | "resend" | null;

type Outcome = "paid" | "written_off" | "resolved";
type Party = "vendor" | "deputy" | "coordinator";
const CLOSE_LABEL: Record<Outcome, string> = { paid: "Close as paid", written_off: "Write off", resolved: "Resolve issue" };
type InvoiceEdit = { start: string; end: string; rate: string; minimumHours: string };
/** What every action form shares: the one text field, the busy flag and the Back button. */
type FieldProps = { text: string; setText: (v: string) => void; busy: boolean; back: React.ReactNode };

/** The edit form: worked times (not for a late cancellation), rate, minimum hours and the reason. */
function EditFields({ lateCancel, edit, setEdit, status, text, setText, busy, back }: Readonly<{ lateCancel: boolean; edit: InvoiceEdit; setEdit: (e: InvoiceEdit) => void; status: string } & FieldProps>) {
  return (
    <>
      {!lateCancel ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <FormField label="Start worked">
            <Input type="datetime-local" value={edit.start} onChange={(e) => setEdit({ ...edit, start: e.target.value })} />
          </FormField>
          <FormField label="End worked">
            <Input type="datetime-local" value={edit.end} onChange={(e) => setEdit({ ...edit, end: e.target.value })} />
          </FormField>
        </div>
      ) : null}
      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Rate per hour" hint="Blank keeps the rate.">
          <Input inputMode="decimal" value={edit.rate} onChange={(e) => setEdit({ ...edit, rate: e.target.value })} />
        </FormField>
        <FormField label="Minimum hours, this invoice only" hint="Blank keeps the usual minimum.">
          <Input inputMode="decimal" value={edit.minimumHours} onChange={(e) => setEdit({ ...edit, minimumHours: e.target.value })} />
        </FormField>
      </div>
      <FormField label="Reason for the change" hint={status === "sent" ? "The vendor gets a revised invoice." : undefined}>
        <Input value={text} onChange={(e) => setText(e.target.value)} required maxLength={500} />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Save invoice
        </Button>
        {back}
      </div>
    </>
  );
}

/** Send back: a comment for the deputy, who fixes the hours and bills again. */
function SendBackFields({ payeeName, text, setText, busy, back }: Readonly<{ payeeName: string } & FieldProps>) {
  return (
    <>
      <FormField label="Comment for the deputy" hint={`${payeeName} fixes the hours and bills again on the same number.`}>
        <TextArea value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Send back invoice
        </Button>
        {back}
      </div>
    </>
  );
}

/** Close the invoice or its issue: the outcome, and a reason (required to close or write off). */
function CloseFields({ mode, outcome, setOutcome, text, setText, busy, back }: Readonly<{ mode: "close" | "closeIssue"; outcome: Outcome; setOutcome: (o: Outcome) => void } & FieldProps>) {
  return (
    <>
      <FormField label="Outcome">
        <Select value={outcome} onChange={(e) => setOutcome(e.target.value as typeof outcome)}>
          <option value="paid">Paid</option>
          {mode === "closeIssue" ? <option value="resolved">Resolved, the invoice continues</option> : null}
          <option value="written_off">Written off</option>
        </Select>
      </FormField>
      <FormField label={mode === "close" || outcome === "written_off" ? "Reason" : "Note"} hint={mode === "closeIssue" && outcome !== "written_off" ? "Optional" : undefined}>
        <Input value={text} onChange={(e) => setText(e.target.value)} required={mode === "close" || outcome === "written_off"} maxLength={1000} />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" variant={outcome === "written_off" ? "danger" : "primary"} busy={busy}>
          {CLOSE_LABEL[outcome]}
        </Button>
        {back}
      </div>
    </>
  );
}

/** Change whose turn it is on the issue, with an optional note. */
function WaitingFields({ waitingOn, party, setParty, text, setText, busy, back }: Readonly<{ waitingOn: string | null; party: Party; setParty: (p: Party) => void } & FieldProps>) {
  return (
    <>
      <FormField label="Waiting on" hint={waitingOn ? `Now waiting on the ${waitingOn}.` : undefined}>
        <Select value={party} onChange={(e) => setParty(e.target.value as typeof party)}>
          <option value="vendor">Vendor (they are emailed)</option>
          <option value="deputy">Deputy</option>
          <option value="coordinator">Coordinator</option>
        </Select>
      </FormField>
      <FormField label="Note" hint={party === "vendor" ? "Optional. Goes to the vendor." : "Optional. The deputy sees it."}>
        <Input value={text} onChange={(e) => setText(e.target.value)} maxLength={1000} />
      </FormField>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Save
        </Button>
        {back}
      </div>
    </>
  );
}

/** Resend: an optional extra address, and who the resend goes to. */
function ResendFields({ billingEmails, attachW9, text, setText, busy, back }: Readonly<{ billingEmails: string[]; attachW9: boolean } & FieldProps>) {
  return (
    <>
      <FormField label="Also send to" hint="Optional. One email address, used for this resend only and not saved to the vendor.">
        <Input type="email" value={text} onChange={(e) => setText(e.target.value)} maxLength={254} autoComplete="off" />
      </FormField>
      <div className="flex flex-col gap-1 rounded-md border border-line bg-subtle p-3 text-sm" data-testid="resend-recipients">
        <span className="font-semibold">This resend goes to</span>
        <span>{[...new Set([...billingEmails, ...(text.trim() ? [text.trim().toLowerCase()] : [])])].join(", ") || "No billing email on file. Add one to the vendor first."}</span>
        {attachW9 ? <span>The W-9 goes only to the vendor&apos;s billing emails.</span> : null}
        <span className="text-muted">Same invoice and revision. Nobody&apos;s response time changes.</span>
      </div>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Resend invoice
        </Button>
        {back}
      </div>
    </>
  );
}

/** A note on the issue, for the deputy or staff only. */
function NoteFields({ internal, setInternal, text, setText, busy, back }: Readonly<{ internal: boolean; setInternal: (v: boolean) => void } & FieldProps>) {
  return (
    <>
      <FormField label="Note">
        <TextArea value={text} onChange={(e) => setText(e.target.value)} required maxLength={2000} />
      </FormField>
      <label className="flex min-h-11 items-center gap-2">
        <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.target.checked)} className="size-4.5 accent-accent" />Staff only (the deputy does not see it)
      </label>
      <div className="flex gap-2">
        <Button type="submit" busy={busy}>
          Add note
        </Button>
        {back}
      </div>
    </>
  );
}

/** The action buttons for the invoice's state; each form button opens its inline form. */
function ActionButtons({
  status,
  busy,
  batched,
  approve,
  canSendPaid,
  canResend,
  canSendNow,
  reviewable,
  issueId,
  onSendApproved,
  open,
}: Readonly<{
  status: string;
  busy: boolean;
  batched: boolean;
  approve: React.ReactNode;
  canSendPaid: boolean;
  canResend: boolean;
  canSendNow: boolean;
  reviewable: boolean;
  issueId: string | null;
  onSendApproved: () => void;
  open: (m: Mode) => void;
}>) {
  return (
    <div className="flex flex-wrap gap-2">
      {status === "pending_review" ? approve : null}
      {canSendPaid ? (
        <Button variant="secondary" busy={busy} onClick={onSendApproved}>
          {batched ? "Send paid invoice with the next batch" : "Send paid invoice"}
        </Button>
      ) : null}
      {canResend ? (
        <Button variant="secondary" onClick={() => open("resend")}>
          Resend invoice
        </Button>
      ) : null}
      {status === "approved_unsent" && canSendNow ? (
        <Button busy={busy} onClick={onSendApproved}>
          {batched ? "Send now, with the next batch" : "Send now"}
        </Button>
      ) : null}
      {reviewable ? (
        <>
          <Button variant="secondary" onClick={() => open("edit")}>
            Edit
          </Button>
          <Button variant="secondary" onClick={() => open("back")}>
            Send back
          </Button>
        </>
      ) : null}
      {(status === "sent" || status === "approved_unsent") && !issueId ? (
        <Button variant="secondary" onClick={() => open("close")}>
          Close
        </Button>
      ) : null}
      {issueId ? (
        <>
          <Button variant="secondary" onClick={() => open("waiting")}>
            Change whose turn
          </Button>
          <Button variant="secondary" onClick={() => open("note")}>
            Add a note
          </Button>
          <Button variant="secondary" onClick={() => open("closeIssue")}>
            Close issue
          </Button>
        </>
      ) : null}
    </div>
  );
}

/** Before approving: whether the vendor gets approved invoices by email, and the W-9 choice when one may be attached. */
function ApproveStep({
  vendorName,
  sendByDefault,
  attachW9,
  payeeName,
  payeeHasW9,
  withW9,
  setWithW9,
  children,
}: Readonly<{ vendorName: string; sendByDefault: boolean; attachW9: boolean; payeeName: string; payeeHasW9: boolean; withW9: boolean; setWithW9: (v: boolean) => void; children: React.ReactNode }>) {
  return (
    <div className="flex flex-col gap-1">
      {!sendByDefault ? <p className="m-0 text-sm text-muted">{vendorName} is set to not get approved invoices by email. You can still send this one.</p> : null}
      {attachW9 ? null : (
        <Check
          label={`Attach ${payeeName}'s W-9`}
          hint={payeeHasW9 ? "Sent with this invoice. The W-9 read is logged under your name." : "No W-9 on file, so none can be attached."}
          checked={withW9}
          disabled={!payeeHasW9}
          onChange={setWithW9}
        />
      )}
      {children}
    </div>
  );
}

/**
 * A coordinator's invoice actions: approve, edit, send back and close; and on an open payment issue, move whose
 * turn it is, add a note, or close it. Each opens a short inline form.
 */
export function StaffInvoiceActions({
  invoiceId,
  status,
  payeeName,
  issueId,
  waitingOn,
  start,
  end,
  lateCancel,
  batched = false,
  attachW9 = false,
  payeeHasW9 = false,
  sendByDefault = true,
  vendorName = "the vendor",
  canSendNow = false,
  canSendPaid = false,
  canResend = false,
  billingEmails = [],
}: Readonly<{
  invoiceId: string;
  status: string;
  payeeName: string;
  issueId: string | null;
  waitingOn: string | null;
  start: string;
  end: string;
  lateCancel: boolean;
  /** Approving queues the invoice for the vendor's next send instead of emailing it. */
  batched?: boolean;
  attachW9?: boolean;
  payeeHasW9?: boolean;
  /** The vendor's "Email approved invoices" setting: which approve choice is the primary one. */
  sendByDefault?: boolean;
  vendorName?: string;
  /** Approved without sending and not marked paid. */
  canSendNow?: boolean;
  /** Paid and never sent: the paid version can still go to the vendor. */
  canSendPaid?: boolean;
  /** Already sent: it can be emailed again. */
  canResend?: boolean;
  billingEmails?: string[];
}>) {
  const [withW9, setWithW9] = useState(false);
  const [mode, setMode] = useState<Mode>(null);
  const [text, setText] = useState("");
  const [edit, setEdit] = useState({ start, end, rate: "", minimumHours: "" });
  const [outcome, setOutcome] = useState<Outcome>("paid");
  const [party, setParty] = useState<Party>("vendor");
  const [internal, setInternal] = useState(false);
  const { run, busy } = useCoordAction();
  const done = () => {
    setMode(null);
    setText("");
  };
  const open = (m: Mode) => {
    setText("");
    setMode(m);
  };
  const reviewable = status === "pending_review" || status === "ready_to_send" || status === "approved_unsent" || status === "sent";
  const approve = (
    <ApproveChoice busy={busy} batched={batched} sendByDefault={sendByDefault} onApprove={(send) => run(() => approveInvoiceAction(invoiceId, { attachW9: withW9, send }))} />
  );
  const buttons = (
    <ActionButtons
      status={status}
      busy={busy}
      batched={batched}
      approve={approve}
      canSendPaid={canSendPaid}
      canResend={canResend}
      canSendNow={canSendNow}
      reviewable={reviewable}
      issueId={issueId}
      onSendApproved={() => run(() => sendApprovedInvoiceAction(invoiceId))}
      open={open}
    />
  );
  if (mode === null) {
    if (status !== "pending_review") return buttons;
    return (
      <ApproveStep vendorName={vendorName} sendByDefault={sendByDefault} attachW9={attachW9} payeeName={payeeName} payeeHasW9={payeeHasW9} withW9={withW9} setWithW9={setWithW9}>
        {buttons}
      </ApproveStep>
    );
  }

  const submit = (e: React.SubmitEvent) => {
    e.preventDefault();
    const call = {
      edit: () => editInvoiceAction({ invoiceId, ...edit, reason: text }),
      back: () => sendBackInvoiceAction({ invoiceId, comment: text, payeeName }),
      close: () => closeInvoiceAction({ invoiceId, outcome: outcome === "resolved" ? "paid" : outcome, reason: text }),
      waiting: () => issueWaitingOnAction({ issueId: issueId!, party, note: text }),
      resend: () => resendInvoiceAction({ invoiceId, alsoTo: text }),
      note: () => issueNoteAction({ issueId: issueId!, note: text, internal }),
      closeIssue: () => closeIssueAction({ issueId: issueId!, outcome, note: text }),
    }[mode];
    run(call, done);
  };
  const back = (
    <Button type="button" variant="secondary" onClick={done}>
      Back
    </Button>
  );
  const fields: FieldProps = { text, setText, busy, back };
  return (
    <form className="flex flex-col gap-3" onSubmit={submit}>
      {mode === "edit" ? <EditFields lateCancel={lateCancel} edit={edit} setEdit={setEdit} status={status} {...fields} /> : null}
      {mode === "back" ? <SendBackFields payeeName={payeeName} {...fields} /> : null}
      {mode === "close" || mode === "closeIssue" ? <CloseFields mode={mode} outcome={outcome} setOutcome={setOutcome} {...fields} /> : null}
      {mode === "waiting" ? <WaitingFields waitingOn={waitingOn} party={party} setParty={setParty} {...fields} /> : null}
      {mode === "resend" ? <ResendFields billingEmails={billingEmails} attachW9={attachW9} {...fields} /> : null}
      {mode === "note" ? <NoteFields internal={internal} setInternal={setInternal} {...fields} /> : null}
    </form>
  );
}
