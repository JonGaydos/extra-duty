"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select, TextArea } from "@/ui/components/FormField";
import { markReceivedAction, reportNonPaymentAction } from "../_personnel/actions";
import { ActionStatus, useAction } from "../_personnel/use-action";

type Method = { id: string; name: string };

/**
 * "Mark received" and, when the rules allow it, "Report non-payment" (worded "Never arrived" when the vendor
 * says it paid). Each opens a short inline form.
 */
export function InvoiceActions({
  invoiceId,
  number,
  methods,
  today,
  canMark,
  canReport,
  vendorSaysPaid,
}: {
  invoiceId: string;
  number: string;
  methods: Method[];
  today: string;
  canMark: boolean;
  canReport: boolean;
  vendorSaysPaid: boolean;
}) {
  const [open, setOpen] = useState<"mark" | "report" | null>(null);
  const [paidDate, setPaidDate] = useState(today);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const { run, busy, result } = useAction();
  if (!canMark && !canReport) return <ActionStatus result={result} />;
  return (
    <div className="flex flex-col gap-3">
      {open === null ? (
        <div className="flex flex-wrap gap-2">
          {canMark ? (
            <Button onClick={() => setOpen("mark")} aria-label={`Mark received, ${number}`}>
              Mark received
            </Button>
          ) : null}
          {canReport ? (
            <Button variant="secondary" onClick={() => setOpen("report")} aria-label={`${vendorSaysPaid ? "Never arrived" : "Report non-payment"}, ${number}`}>
              {vendorSaysPaid ? "Never arrived" : "Report non-payment"}
            </Button>
          ) : null}
        </div>
      ) : open === "mark" ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => markReceivedAction({ invoiceId, paidDate, methodId, reference, note }), () => setOpen(null));
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Date received">
              <Input type="date" value={paidDate} max={today} onChange={(e) => setPaidDate(e.target.value)} required />
            </FormField>
            <FormField label="Method">
              <Select value={methodId} onChange={(e) => setMethodId(e.target.value)} required>
                {methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Check or reference number" hint="Optional">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
            </FormField>
            <FormField label="Note" hint="Optional">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </FormField>
          </div>
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              Record payment
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => reportNonPaymentAction({ invoiceId, note }), () => setOpen(null));
          }}
        >
          <FormField label="What happened" hint="Optional. The extra duty office reads this.">
            <TextArea value={note} onChange={(e) => setNote(e.target.value)} maxLength={1000} />
          </FormField>
          <div className="flex gap-2">
            <Button type="submit" busy={busy}>
              Report non-payment
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(null)}>
              Cancel
            </Button>
          </div>
        </form>
      )}
      <ActionStatus result={result} />
    </div>
  );
}
