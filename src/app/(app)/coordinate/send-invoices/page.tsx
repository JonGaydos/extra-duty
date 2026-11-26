import type { Metadata } from "next";
import { InvoicePdfLink } from "../../invoices/[id]/InvoicePdfLink";
import { withTx } from "@/ui/shell/request";
import { listInvoiceBatches, waitingText, type VendorBatch } from "@/domain/invoices/batch";
import { sendDayLabel } from "@/domain/invoices/send-schedule";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { dollars } from "@/ui/components/PayLabel";
import { PageTitle } from "../../_personnel/TabLinks";
import { dayLabel, plural } from "../../_personnel/format";
import { coordinatorActor } from "../_coordinator/session";
import { SendBatchForm } from "./SendBatchForm";

export const metadata: Metadata = { title: "Send invoices" };

function sendSummary(vendors: number, due: number): string {
  if (!vendors) return "Approved invoices wait here for each vendor's send day.";
  const dueText = due ? `, ${due} due` : "";
  return `${plural(vendors, "vendor")} with invoices ready to send${dueText}.`;
}

const SCHEDULE_TEXT: Record<VendorBatch["schedule"], string> = {
  immediate: "Sends right away",
  weekly: "Weekly send",
  every_2_weeks: "Every two weeks",
  monthly: "Monthly send",
};

function BatchCard({ b }: Readonly<{ b: VendorBatch }>) {
  const headingId = `vendor-${b.vendorId}-heading`;
  const ready = b.invoices.filter((i) => !i.waiting);
  const held = b.invoices.length - ready.length;
  // W-9s the deputies asked for that cannot be found: shown even when "attach for all" is off.
  const askedMissing = b.invoices.some((i) => i.attachW9 && !i.hasW9);
  return (
    <Card id={`vendor-${b.vendorId}`} aria-labelledby={headingId} className="scroll-mt-24">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={headingId} className="m-0 text-title font-semibold md:text-base">
            {b.vendorName}
          </h2>
          <p className="m-0 text-sm text-muted">
            {SCHEDULE_TEXT[b.schedule]}, {b.due ? "due" : "scheduled"} {sendDayLabel(b.sendDay)}.
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          {b.due ? <Chip tone="attention">Due</Chip> : <Chip tone="info">Not due yet</Chip>}
          {held ? <Chip tone="warning">{`${plural(held, "invoice")} on hold`}</Chip> : null}
        </div>
      </div>

      <ul className="m-0 flex list-none flex-col divide-y divide-divider rounded-md border border-line p-0">
        {b.invoices.map((i) => (
          <li key={i.id} className="flex flex-col gap-1 px-3.5 py-2.75 sm:flex-row sm:items-start sm:justify-between sm:gap-4">
            <div className="flex min-w-0 flex-col gap-0.5">
              <span className="font-semibold">
                {i.payeeName}
                <span className="font-normal text-muted">, {i.number}</span>
              </span>
              <span className="text-sm text-muted">
                #{i.jobNumber} {i.jobTitle}, {dayLabel(i.jobStartAt)}
              </span>
              <span className="flex flex-wrap gap-1.5 pt-0.5 empty:hidden">
                {i.paid ? <Chip tone="success">Paid, nothing due</Chip> : null}
                {i.waiting ? <Chip tone="warning">Held for the detail</Chip> : null}
                {i.attachW9 ? <Chip tone={i.hasW9 ? "neutral" : "danger"}>{i.hasW9 ? "W-9 requested" : "W-9 requested, none on file"}</Chip> : null}
              </span>
            </div>
            <span className="flex shrink-0 flex-col sm:items-end">
              <span className="font-semibold sm:text-right" data-numeric>
                {dollars(i.totalCents)}
              </span>
              <InvoicePdfLink id={i.id} number={i.number} compact />
            </span>
          </li>
        ))}
      </ul>

      <p className="m-0 flex flex-wrap items-baseline justify-between gap-2 text-body">
        <span className="text-muted">{plural(ready.length, "invoice")} ready now</span>
        <span className="text-lg font-bold" data-numeric>
          {dollars(b.totalCents)}
        </span>
      </p>

      {b.lastSendFailed ? (
        <Notice tone="danger" as="div">
          <strong className="font-semibold">Last send failed:</strong> {b.lastSendFailed}
        </Notice>
      ) : null}

      {b.waiting.length ? (
        <Notice tone="warning" as="div">
          <span className="flex flex-col gap-1">
            <strong className="font-semibold">Held until each detail&apos;s invoices can go together</strong>
            {b.waiting.map((w) => (
              <span key={w.jobId}>
                #{w.jobNumber} {w.jobTitle}: {waitingText(w)}
              </span>
            ))}
          </span>
        </Notice>
      ) : null}

      <SendBatchForm
        vendorId={b.vendorId}
        vendorName={b.vendorName}
        due={b.due}
        invoices={b.invoices.map((i) => ({ totalCents: i.totalCents, paid: i.paid, waiting: i.waiting, attachW9: i.attachW9, hasW9: i.hasW9 }))}
        hasWaiting={b.waiting.length > 0}
        missingW9={b.missingW9.map((m) => m.name)}
        askedMissing={askedMissing}
      />
    </Card>
  );
}

/**
 * Invoices approved in a batch mode, one card per vendor. Each vendor gets one email with every invoice, the W-9s
 * asked for and a cover summary. A batch before its send day, or with details still waiting on deputies, can go
 * early with a reason.
 */
export default async function SendInvoicesPage() {
  const actor = await coordinatorActor();
  const batches = await withTx((tx) => listInvoiceBatches(actor, tx));
  const due = batches.filter((b) => b.due).length;
  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub={sendSummary(batches.length, due)}>
        Send invoices
      </PageTitle>
      {batches.length === 0 ? (
        <Card pad={false}>
          <EmptyState title="Nothing queued">Invoices approved for a weekly, every-two-weeks or monthly send show up here.</EmptyState>
        </Card>
      ) : (
        <div className="grid gap-4.5 lg:grid-cols-2 lg:items-start">
          {batches.map((b) => (
            <BatchCard key={b.vendorId} b={b} />
          ))}
        </div>
      )}
    </div>
  );
}
