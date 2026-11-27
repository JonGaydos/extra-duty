"use client";

import { outsideRange, rateRangeMessage, type RateRange } from "@/domain/jobs/rate";
import { FormField, TextArea } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";

/** Dollars as typed to cents, or null when blank or unreadable. */
export function typedCents(v: string): number | null {
  const t = v.replace(/[$,\s]/g, "");
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) return null;
  const [w, c = ""] = t.split(".");
  return Number(w) * 100 + Number(c.padEnd(2, "0"));
}

/**
 * Shown under the rate when it is outside the agency range. On a single detail a coordinator or admin can
 * approve it with a reason; a series edit or several dates cannot, and a vendor manager (`approver` false) never can.
 */
export function RateRangeNotice({ rateCents, range, reason, onReason, canApprove, approved, approver = true }: Readonly<{ rateCents: number | null; range: RateRange; reason: string; onReason: (v: string) => void; canApprove: boolean; approved?: boolean; approver?: boolean }>) {
  if (rateCents === null || !outsideRange(rateCents, range) || approved) return null;
  let how = "An exception can be approved only on a single detail, not on several dates or a series.";
  if (!approver) how = "Choose a rate inside the range. Only a coordinator can approve an exception.";
  else if (canApprove) how = "Give a reason to approve it for this one detail.";
  return (
    <div className="flex flex-col gap-2.5 md:col-span-2">
      <Notice tone="warning" as="div">
        <strong className="font-semibold">Rate outside the agency range.</strong> {rateRangeMessage(range)}. {how}
      </Notice>
      {canApprove && approver ? (
        <FormField label="Reason for the exception" hint="Shown on the staff detail page and kept in the audit log. Never printed on invoices.">
          <TextArea value={reason} onChange={(e) => onReason(e.target.value)} maxLength={500} />
        </FormField>
      ) : null}
    </div>
  );
}
