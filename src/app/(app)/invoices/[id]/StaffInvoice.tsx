import Link from "next/link";
import type { PaymentIssueView } from "@/domain/payment-issues/issues";
import type { StaffInvoice as Invoice } from "@/domain/coordinator/views";
import { ActionLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip, type ChipTone } from "@/ui/components/Chip";
import { EmailLinks, PhoneLink } from "@/ui/components/ContactList";
import { Notice } from "@/ui/components/Notice";
import { PayLabel } from "@/ui/components/PayLabel";
import { Icon } from "@/ui/icons";
import { clock, dateLabel, dateTime, hoursText, localInput, timeRange, dayLabel } from "../../_personnel/format";
import { StatusProvider } from "../../coordinate/_coordinator/status";
import { eventLabel } from "./invoice-events";
import { InvoicePdfLink } from "./InvoicePdfLink";
import { StaffInvoiceActions } from "./StaffInvoiceActions";

const PARTY: Record<string, string> = { deputy: "Deputy", vendor: "Vendor", coordinator: "Coordinator" };

const TURN: Record<string, { tone: ChipTone; text: string }> = {
  coordinator: { tone: "coordinator", text: "Coordinator's turn" },
  deputy: { tone: "attention", text: "Deputy's turn" },
};
const VENDOR_TURN: { tone: ChipTone; text: string } = { tone: "neutral", text: "Vendor's turn" };

function workedText(inv: Invoice): string {
  if (inv.worked) return timeRange(inv.worked.startAt, inv.worked.endAt);
  return inv.kind === "late_cancel" ? "Late cancellation minimum" : "Not billed yet";
}

/** An open payment issue: since when, who it waits on, what the deputy said and what the vendor reports. */
function IssueNotice({ issue, waitingOn }: Readonly<{ issue: PaymentIssueView; waitingOn: Invoice["issueWaitingOn"] }>) {
  const paid = issue.vendorPaid;
  const reference = paid?.reference ? `, ${paid.reference}` : "";
  return (
    <Notice tone="warning">
      Payment issue open since {dateLabel(issue.openedAt)}, waiting on the {waitingOn}.{issue.note ? ` Deputy said: ${issue.note}` : ""}
      {paid ? ` Vendor reports paid ${dateLabel(paid.paidAt)}${reference}.` : ""}
    </Notice>
  );
}

/** Who sees an issue note: staff only, or sent to the vendor. */
function VisibilityChip({ visibility }: Readonly<{ visibility: string }>) {
  if (visibility === "internal") return <Chip>Staff only</Chip>;
  return visibility === "vendor" ? <Chip>Sent to vendor</Chip> : null;
}

/** The deputy, vendor, detail, amount, and the scheduled and worked times. */
function InvoiceFacts({ inv }: Readonly<{ inv: Invoice }>) {
  return (
    <dl className="m-0 grid gap-3 sm:grid-cols-2">
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-semibold text-muted">Deputy</dt>
        <dd className="m-0 flex flex-col gap-0.5">
          <span>{inv.payeeName}</span>
          <EmailLinks emails={[inv.payeeEmail]} />
          {inv.payeePhone ? <PhoneLink phone={inv.payeePhone} /> : null}
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-semibold text-muted">Vendor</dt>
        <dd className="m-0">
          <Link href={`/coordinate/vendors/${inv.vendorId}`}>{inv.vendorName}</Link>
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-semibold text-muted">Detail</dt>
        <dd className="m-0">
          <Link href={`/coordinate/details/${inv.jobId}`}>
            #{inv.jobNumber} {inv.jobTitle}
          </Link>
          , {dayLabel(inv.scheduled.startAt)}
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-semibold text-muted">Amount</dt>
        <dd className="m-0">
          <PayLabel variant="plain" totalCents={inv.totalCents} rateCents={inv.rateCents} /> <span className="text-muted">for {hoursText(inv.minutes, true)}</span>
        </dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-semibold text-muted">Scheduled</dt>
        <dd className="m-0">{timeRange(inv.scheduled.startAt, inv.scheduled.endAt)}</dd>
      </div>
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs font-semibold text-muted">Worked</dt>
        <dd className="m-0">{workedText(inv)}</dd>
      </div>
    </dl>
  );
}

/** The reason hours changed, a queued send, an approved invoice not sent, and who must respond by when. */
function InvoiceNotices({ inv }: Readonly<{ inv: Invoice }>) {
  return (
    <>
      {inv.changeReason ? <p className="m-0 text-sm">Reason given: &ldquo;{inv.changeReason}&rdquo;</p> : null}
      {inv.queuedSend ? (
        <Notice tone="info">
          {inv.queuedSend}{" "}
          <Link href={`/coordinate/send-invoices#vendor-${inv.vendorId}`}>Review the batch</Link>
        </Notice>
      ) : null}
      {inv.status === "approved_unsent" ? (
        <Notice tone="info">Approved, not sent. The vendor does not see this invoice until it is sent, and nobody&apos;s response time runs until then.</Notice>
      ) : null}
      {inv.party && inv.dueAt ? (
        <p className="m-0 text-sm text-muted">
          {PARTY[inv.party]} has until {dateTime(inv.dueAt)} to respond{inv.overdue ? "; that time has passed" : ""}.
        </p>
      ) : null}
    </>
  );
}

export function turnChip(status: string, party: string | null, overdue: boolean): { tone: ChipTone; text: string } {
  if (status === "paid") return { tone: "success", text: "Paid" };
  if (status === "written_off") return { tone: "danger", text: "Written off" };
  if (status === "pending_review") return { tone: "coordinator", text: "Waiting for review" };
  if (status === "ready_to_send") return { tone: "info", text: "Ready to send" };
  if (status === "approved_unsent") return { tone: "neutral", text: "Approved, not sent" };
  const turn = TURN[party ?? ""] ?? VENDOR_TURN;
  return { tone: overdue ? "danger" : turn.tone, text: overdue ? `${turn.text}, overdue` : turn.text };
}

/** Coordinators and admins: the whole timeline (names included), the issue's notes and every action. */
export function StaffInvoice({ inv, issue, payeeActions }: Readonly<{ inv: Invoice; issue: PaymentIssueView | null; /** The actor's own invoice: their payee actions (mark received, report non-payment). */ payeeActions?: React.ReactNode }>) {
  const chip = turnChip(inv.status, inv.party, inv.overdue);
  return (
    <StatusProvider>
      <div className="mx-auto flex w-full max-w-180 flex-col gap-4.5">
        <Link href="/coordinate/payments" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
          <Icon name="chevronLeft" size={18} />
          Back to payments
        </Link>
        <Card>
          <div className="flex flex-wrap items-center gap-1.5">
            <Chip tone={chip.tone}>{chip.text}</Chip>
            {inv.kind === "late_cancel" ? <Chip tone="warning">Late cancellation</Chip> : null}
            {inv.revision > 0 ? <Chip>Revision {inv.revision}</Chip> : null}
            {inv.vendorOnHold ? <Chip tone="danger">Vendor on payment hold</Chip> : null}
          </div>
          <h1 className="m-0 text-2xl font-bold md:text-3xl">Invoice {inv.number}</h1>
          <InvoiceFacts inv={inv} />
          <InvoiceNotices inv={inv} />
          {issue ? <IssueNotice issue={issue} waitingOn={inv.issueWaitingOn} /> : null}
          <StaffInvoiceActions
            invoiceId={inv.id}
            status={inv.status}
            payeeName={inv.payeeName}
            issueId={inv.issueId}
            waitingOn={inv.issueWaitingOn}
            start={inv.worked ? localInput(inv.worked.startAt) : localInput(inv.scheduled.startAt)}
            end={inv.worked ? localInput(inv.worked.endAt) : localInput(inv.scheduled.endAt)}
            lateCancel={inv.kind === "late_cancel"}
            batched={inv.sendSchedule !== "immediate"}
            sendByDefault={inv.sendByDefault}
            canSendNow={inv.canSendNow}
            canSendPaid={inv.canSendPaid}
            canResend={inv.sentAt !== null && inv.status !== "returned"}
            billingEmails={inv.vendorBillingEmails}
            vendorName={inv.vendorName}
            attachW9={inv.attachW9}
            payeeHasW9={inv.payeeHasW9}
          />
          {payeeActions ? (
            <div className="flex flex-col gap-2 border-t border-divider pt-3">
              <p className="m-0 text-sm text-muted">This is your own invoice.</p>
              {payeeActions}
            </div>
          ) : null}
          {inv.vendorOnHold ? (
            <ActionLink href={`/coordinate/vendors/${inv.vendorId}#hold`}>Resolve the vendor hold on the vendor record</ActionLink>
          ) : null}
          <InvoicePdfLink id={inv.id} number={inv.number} />
        </Card>
        {issue?.notes.length ? (
          <Card>
            <CardTitle>Issue notes</CardTitle>
            <ul className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              {issue.notes.map((n) => (
                <li key={n.id}>
                  <span className="text-muted">{dateTime(n.at)}:</span> {n.note} <VisibilityChip visibility={n.visibility} />
                </li>
              ))}
            </ul>
          </Card>
        ) : null}
        <Card>
          <CardTitle>Timeline</CardTitle>
          {inv.timeline.length === 0 ? (
            <p className="m-0 text-sm text-muted">Nothing has happened on this invoice yet.</p>
          ) : (
            <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
              {[...inv.timeline].reverse().map((e) => (
                <li key={e.id} className="grid grid-cols-[5.5rem_1fr] gap-3 text-sm">
                  <span className="font-semibold" data-numeric>
                    {dateLabel(e.at).replace(/, \d{4}$/, "")}
                    <span className="block text-xs font-normal text-muted">{clock(e.at)}</span>
                  </span>
                  <span>
                    {e.actorName ?? (e.party ? PARTY[e.party] : "System")}: {eventLabel(e.event)}
                    {e.event === "issue_waiting_on" && e.party ? ` the ${e.party}` : ""}
                    {e.note ? `. ${e.note}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          )}
          <p className="m-0 text-xs text-muted">Times are Central.</p>
        </Card>
      </div>
    </StatusProvider>
  );
}
