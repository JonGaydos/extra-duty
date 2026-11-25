"use client";

import { useId, useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, TextArea } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { dollars } from "@/ui/components/PayLabel";
import { Switch } from "../../admin/_admin/forms";
import { plural } from "../../_personnel/format";
import { sendInvoiceBatchAction } from "../_coordinator/actions";
import { useCoordAction } from "../_coordinator/status";
import { totalDue } from "./batch-total";

export type BatchFormInvoice = { totalCents: number; paid: boolean; waiting: boolean; attachW9: boolean; hasW9: boolean };

/**
 * The send controls for one vendor batch: W-9s, missing W-9s, early sends and the reason they need. Sending emails
 * the vendor at once, cannot be undone and starts the vendor's response clock, so it asks to confirm first, naming
 * the vendor, the count, the total and the W-9s.
 */
export function SendBatchForm({
  vendorId,
  vendorName,
  due,
  invoices,
  hasWaiting,
  missingW9,
  askedMissing,
}: {
  vendorId: string;
  vendorName: string;
  due: boolean;
  invoices: BatchFormInvoice[];
  hasWaiting: boolean;
  missingW9: string[];
  askedMissing: boolean;
}) {
  const id = useId();
  const [attachAll, setAttachAll] = useState(false);
  const [includeWaiting, setIncludeWaiting] = useState(false);
  const [missing, setMissing] = useState<"send" | "hold">("send");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const { run, busy, error } = useCoordAction();
  const early = !due || (includeWaiting && hasWaiting);
  const showMissing = missingW9.length > 0 && (attachAll || askedMissing);
  const wantsW9 = (i: BatchFormInvoice) => i.attachW9 || attachAll;
  // The same choice the server makes: waiting invoices only when asked, missing W-9s held only when chosen.
  const going = invoices.filter((i) => (includeWaiting || !i.waiting) && !(missing === "hold" && wantsW9(i) && !i.hasW9));
  const count = going.length;
  const total = totalDue(going);
  const w9s = going.filter((i) => wantsW9(i) && i.hasW9).length;
  const reasonMissing = early && !reason.trim();
  const reasonError = error && !error.ok && error.error === "Give a reason for sending early." ? error.error : undefined;
  const change = <T,>(set: (v: T) => void) => (v: T) => {
    setConfirming(false);
    set(v);
  };

  return (
    <form
      noValidate
      aria-label={`Send invoices to ${vendorName}`}
      className="flex flex-col gap-3 border-t border-divider pt-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!confirming) {
          setConfirming(true);
          return;
        }
        run(() => sendInvoiceBatchAction({ vendorId, attachW9ForAll: attachAll, missingW9: missing, includeWaiting, reason }), () => setConfirming(false));
      }}
    >
      <Switch label="Attach W-9s for every deputy in this batch" hint="Each deputy's current W-9 goes with their invoice, whatever they chose." checked={attachAll} onChange={change(setAttachAll)} />
      {showMissing ? (
        <fieldset className="m-0 flex flex-col gap-1 rounded-md border border-warning-line bg-warning-soft px-3.5 py-2.5" aria-describedby={`${id}-missing`}>
          <legend className="sr-only">Deputies without a W-9</legend>
          <p id={`${id}-missing`} className="m-0 text-sm text-warning-ink">
            <strong className="font-semibold">No W-9 on file:</strong> {missingW9.join(", ")}
          </p>
          {(["send", "hold"] as const).map((v) => (
            <label key={v} className="flex min-h-11 cursor-pointer items-center gap-2.5 text-body">
              <input type="radio" name={`${id}-missing`} value={v} checked={missing === v} onChange={() => change(setMissing)(v)} className="size-4.5 shrink-0 accent-accent" />
              {v === "send" ? "Send their invoices without a W-9" : "Hold their invoices for a later send"}
            </label>
          ))}
        </fieldset>
      ) : null}
      {hasWaiting ? (
        <Switch label="Also send the invoices on hold" hint="They go now instead of waiting for the rest of their detail to bill or be reviewed." checked={includeWaiting} onChange={change(setIncludeWaiting)} />
      ) : null}
      {early ? (
        <FormField label="Reason for sending early" hint={!due ? "This batch is before its send day." : "Some invoices on these details are not ready yet."} error={reasonError}>
          <TextArea value={reason} onChange={(e) => change(setReason)(e.target.value)} maxLength={500} rows={2} />
        </FormField>
      ) : null}
      {count === 0 ? (
        <Notice tone="info">Nothing can go yet. Send the invoices on hold with a reason, or wait for their details to be complete.</Notice>
      ) : null}
      {confirming ? (
        <div role="group" aria-labelledby={`${id}-confirm`} className="flex flex-col gap-2.5 rounded-md border border-accent-outline bg-accent-soft px-3.5 py-3">
          <p id={`${id}-confirm`} className="m-0 text-body text-ink">
            Email <strong className="font-semibold">{plural(count, "invoice")}</strong> totaling{" "}
            <strong className="font-semibold" data-numeric>
              {dollars(total)}
            </strong>{" "}
            to <strong className="font-semibold">{vendorName}</strong>, {w9s ? `with ${plural(w9s, "W-9")} attached` : "with no W-9s attached"}?
          </p>
          <p className="m-0 text-sm text-muted">This cannot be undone. The vendor&apos;s time to pay starts now.</p>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Button type="submit" busy={busy} className="w-full sm:w-fit">
              Send now
            </Button>
            <Button type="button" variant="secondary" onClick={() => setConfirming(false)} className="w-full sm:w-fit">
              Back
            </Button>
          </div>
        </div>
      ) : (
        <Button type="submit" disabled={count === 0 || reasonMissing} className="w-full md:w-fit">
          {early ? "Send early" : "Send"} {plural(count, "invoice")} to {vendorName}
        </Button>
      )}
      {reasonMissing && count > 0 ? <p className="m-0 text-xs text-muted">Give a reason to send early.</p> : null}
    </form>
  );
}
