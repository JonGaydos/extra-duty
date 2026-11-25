"use client";

import { useState } from "react";
import { Button } from "@/ui/components/Button";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { ActionStatus, useAction } from "../../_personnel/use-action";
import { vendorMarkPaidAction } from "../_vendor/actions";

type Method = { id: string; name: string };

/** "Mark paid" on the vendor's side: date, method and reference in a short inline form (spec 12.8). */
export function MarkPaid({ invoiceId, number, methods, today, canMark }: { invoiceId: string; number: string; methods: Method[]; today: string; canMark: boolean }) {
  const [open, setOpen] = useState(false);
  const [paidDate, setPaidDate] = useState(today);
  const [methodId, setMethodId] = useState(methods[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [note, setNote] = useState("");
  const { run, busy, result } = useAction();
  return (
    <div className="flex flex-col gap-3">
      {!canMark ? null : open ? (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() => vendorMarkPaidAction({ invoiceId, paidDate, methodId, reference, note }), () => setOpen(false));
          }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Date paid">
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
            <FormField label="Check or reference number" hint="Optional. The deputy sees it.">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
            </FormField>
            <FormField label="Note" hint="Optional">
              <Input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} />
            </FormField>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" busy={busy}>
              Record payment
            </Button>
            <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
              Close
            </Button>
          </div>
        </form>
      ) : (
        <Button className="w-full sm:w-fit" onClick={() => setOpen(true)} aria-label={`Mark paid, invoice ${number}`}>
          Mark paid
        </Button>
      )}
      <ActionStatus result={result} />
    </div>
  );
}
