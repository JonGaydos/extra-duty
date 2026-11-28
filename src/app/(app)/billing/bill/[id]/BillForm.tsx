"use client";

import Link from "next/link";
import { useState } from "react";
import { billableMinutes, invoiceTotal, reviewDecision } from "@/domain/billing/rules";
import { Button } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { FormField, Input, Select } from "@/ui/components/FormField";
import { Notice } from "@/ui/components/Notice";
import { dollars } from "@/ui/components/PayLabel";
import { billAction } from "../../../_personnel/actions";
import { ActionStatus, useAction } from "../../../_personnel/use-action";

const REASONS = ["Vendor asked me to stay", "Started late", "Ended early"];

type Props = {
  assignmentId: string;
  plannedStart: string;
  plannedEnd: string;
  lateCancel: boolean;
  rateCents: number;
  rounding: number;
  minimum: number;
  reviewMode: "immediate" | "changed_hours_only" | "all";
  w9: string | null;
  /** This vendor needs a W-9 signed this year and the approved one is older: it will not be attached. */
  w9Notice?: string | null;
  sendsTo: string[];
  payee: string;
  mailingAddress: string | null;
  methods: Array<{ id: string; name: string }>;
  /** Minutes already worked at the planned times, for the late-cancel case. */
  lateCancelMinutes: number;
  /** Set when staff bill for someone else (someone who left the agency): where to go back to afterwards. */
  onBehalf?: { backHref: string; backLabel: string };
};

/** Parses "YYYY-MM-DDTHH:mm" as a plain wall clock (both sides use the same zone, so only the difference matters). */
const wall = (v: string) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(v);
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]) : Number.NaN;
};
const hm = (minutes: number) => {
  const rest = minutes % 60 ? ` ${minutes % 60} m` : "";
  return `${Math.floor(minutes / 60)} h${rest}`;
};

/** Minutes billed: late-cancel hours as they are, worked time rounded and raised to the minimum, 0 for bad times. */
function billedMinutes(p: Readonly<Props>, worked: number, valid: boolean): number {
  if (!valid) return 0;
  return p.lateCancel ? worked : billableMinutes(worked, { minimumBillableMinutes: p.minimum, hourRoundingMinutes: p.rounding });
}

/** The reason chips and field shown once the hours differ from the plan. */
function ChangeReason({ reason, setReason }: Readonly<{ reason: string; setReason: (r: string) => void }>) {
  return (
    <div className="flex flex-col gap-2.5">
      <p className="m-0 text-sm font-medium text-warning-ink">Hours changed, so a reason is required</p>
      <div className="flex flex-wrap gap-2">
        {REASONS.map((r) => (
          <button
            key={r}
            type="button"
            aria-pressed={reason === r}
            onClick={() => setReason(r)}
            className={`inline-flex h-8.5 items-center rounded-full border px-3.5 text-sm pointer-coarse:h-11 ${
              reason === r ? "border-ink bg-ink font-semibold text-surface" : "border-line bg-surface font-medium text-ink hover:bg-subtle"
            }`}
          >
            {r}
          </button>
        ))}
      </div>
      <FormField label="Reason">
        <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} />
      </FormField>
    </div>
  );
}

/** Worked and billed time, the rate and the invoice total. */
function BillPreview({ p, worked, billed, valid, total }: Readonly<{ p: Readonly<Props>; worked: number; billed: number; valid: boolean; total: number }>) {
  return (
    <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-1.5 border-t border-divider pt-3 text-body" data-numeric>
      <dt className="text-muted">Worked</dt>
      <dd className="m-0 text-right">{valid ? hm(worked) : "Check the times"}</dd>
      <dt className="text-muted">Billed (rounded up to {p.rounding} min, {hm(p.minimum)} minimum)</dt>
      <dd className="m-0 text-right">{valid ? hm(billed) : ""}</dd>
      <dt className="text-muted">Rate</dt>
      <dd className="m-0 text-right">{dollars(p.rateCents)} an hour</dd>
      <dt className="font-semibold">Total</dt>
      <dd className="m-0 text-right text-stat font-bold">{dollars(total)}</dd>
    </dl>
  );
}

/** A vendor that needs a W-9 signed this year, when the approved one is older. */
function W9Notice({ text }: Readonly<{ text?: string | null }>) {
  return text ? <Notice tone="warning">{text}</Notice> : null;
}

function w9Note(p: Readonly<Props>): string {
  if (p.w9) return `Approved W-9, uploaded ${p.w9}`;
  return p.onBehalf ? "No approved W-9 on file." : "No approved W-9 on file. Upload one in Profile; it can go once approved.";
}

/** Billing needs a mailing address: it prints on the invoice. */
function MailingAddressNotice({ p }: Readonly<{ p: Readonly<Props> }>) {
  if (p.mailingAddress) return null;
  if (p.onBehalf) return <Notice tone="warning">There is no mailing address on their account, so this cannot be billed yet. It prints on the invoice.</Notice>;
  return (
    <Notice tone="warning">
      Add your mailing address in <Link href="/profile#contact">Profile</Link> before billing. It prints on the invoice.
    </Notice>
  );
}

/**
 * Hours worked, the invoice preview and how the vendor paid at the detail. Changed hours need a reason and go to
 * a coordinator first when the agency reviews changed hours; the button says which will happen.
 */
export function BillForm(p: Readonly<Props>) {
  const [start, setStart] = useState(p.plannedStart);
  const [end, setEnd] = useState(p.plannedEnd);
  const [reason, setReason] = useState("");
  // A W-9 goes only when ticked (owner decision, batched sending): having one on file does not attach it.
  const [attachW9, setAttachW9] = useState(false);
  const [paid, setPaid] = useState(false);
  const [methodId, setMethodId] = useState(p.methods[0]?.id ?? "");
  const [reference, setReference] = useState("");
  const [done, setDone] = useState(false);
  const { run, busy, result } = useAction();

  const changed = !p.lateCancel && (start !== p.plannedStart || end !== p.plannedEnd);
  const worked = p.lateCancel ? p.lateCancelMinutes : Math.round((wall(end) - wall(start)) / 60_000);
  const valid = Number.isFinite(worked) && worked > 0;
  const billed = billedMinutes(p, worked, valid);
  const total = valid ? invoiceTotal(billed, p.rateCents) : 0;
  const hold = reviewDecision(p.reviewMode, changed) === "hold";

  if (done) {
    return (
      <Card>
        <ActionStatus result={result} />
        <Link href={p.onBehalf?.backHref ?? "/billing"} className="text-sm font-semibold">
          {p.onBehalf?.backLabel ?? "Back to billing"}
        </Link>
      </Card>
    );
  }

  return (
    <form
      className="flex flex-col gap-4.5"
      onSubmit={(e) => {
        e.preventDefault();
        run(
          () => billAction({ assignmentId: p.assignmentId, start, end, reason, attachW9, paidOnSpot: paid ? { methodId, reference } : null }),
          () => setDone(true),
          false,
        );
      }}
    >
      <Card>
        <CardTitle>Hours worked</CardTitle>
        {p.lateCancel ? (
          <Notice tone="info">This detail was canceled late, so it bills at the agency&apos;s late-cancel hours. The times are fixed.</Notice>
        ) : (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <FormField label="Start">
              <Input type="datetime-local" step={60} value={start} onChange={(e) => setStart(e.target.value)} required />
            </FormField>
            <FormField label="End">
              <Input type="datetime-local" step={60} value={end} onChange={(e) => setEnd(e.target.value)} required />
            </FormField>
          </div>
        )}
        {changed ? <ChangeReason reason={reason} setReason={setReason} /> : null}
        <BillPreview p={p} worked={worked} billed={billed} valid={valid} total={total} />
        {hold ? <p className="m-0 text-sm text-muted">{changed ? "Changed hours go to a coordinator for review before the invoice is sent." : "A coordinator reviews every invoice before it is sent."}</p> : null}
      </Card>

      <Card>
        <CardTitle>Invoice</CardTitle>
        <W9Notice text={p.w9Notice} />
        <label className="flex min-h-11 items-center gap-2.5">
          <input type="checkbox" checked={attachW9} disabled={p.w9 === null} onChange={(e) => setAttachW9(e.target.checked)} className="size-4.5 accent-accent" />
          <span className="flex flex-col">
            <span>{p.onBehalf ? "Attach their W-9" : "Attach my W-9"}</span>
            <span className="text-xs text-muted">{w9Note(p)}</span>
          </span>
        </label>
        <p className="m-0 text-sm text-muted">
          Sends to {p.sendsTo.length ? p.sendsTo.join(", ") : "the vendor's billing email"}. Pay to: {p.payee}, {p.onBehalf ? "their" : "your"} mailing address and email. Questions go to the extra duty office.
        </p>
        <MailingAddressNotice p={p} />
      </Card>

      <Card>
        <label className="flex min-h-11 items-center justify-between gap-3">
          <span className="font-semibold">Paid at the detail</span>
          <input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} className="size-4.5 accent-accent" />
        </label>
        {paid ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <FormField label="Method">
              <Select value={methodId} onChange={(e) => setMethodId(e.target.value)}>
                {p.methods.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.name}
                  </option>
                ))}
              </Select>
            </FormField>
            <FormField label="Check or reference number" hint="Optional">
              <Input value={reference} onChange={(e) => setReference(e.target.value)} maxLength={100} />
            </FormField>
            <p className="m-0 text-sm text-muted sm:col-span-2">The vendor gets the invoice marked Paid as a receipt and confirms it on their side.</p>
          </div>
        ) : null}
      </Card>

      <ActionStatus result={result} />
      <Button type="submit" size="lg" full busy={busy} disabled={!valid}>
        {hold ? "Submit for review" : "Send invoice"}
      </Button>
    </form>
  );
}
