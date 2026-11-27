import type { Metadata } from "next";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { invoiceTimeline, type TimelineEvent } from "@/domain/billing/payments";
import { DomainError, NotFoundError } from "@/domain/errors";
import { staffInvoice } from "@/domain/coordinator/views";
import { getPaymentIssue } from "@/domain/payment-issues/issues";
import { activePaymentMethods, myInvoices } from "@/domain/personnel/views";
import { agencyDayKey } from "@/domain/time/agency-time";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { PayLabel } from "@/ui/components/PayLabel";
import type { Actor } from "@/domain/actor";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { InvoiceActions } from "../../billing/InvoiceActions";
import { clock, dateLabel, dayLabel, hoursText } from "../../_personnel/format";
import { invoiceSentence } from "../../_personnel/invoice-text";
import { StaffInvoice } from "./StaffInvoice";
import { PAYEE_INVOICE_EVENT, eventLabel } from "./invoice-events";

export const metadata: Metadata = { title: "Invoice" };

type Props = { params: Promise<{ id: string }> };

const PARTY: Record<string, string> = { deputy: "You", vendor: "Vendor", coordinator: "Coordinator" };

function eventText(e: TimelineEvent): string {
  const what = eventLabel(e.event, PAYEE_INVOICE_EVENT);
  const who = e.party ? `${PARTY[e.party] ?? e.party}: ` : "";
  const note = e.note ? `. ${e.note}` : "";
  return `${who}${what}${note}`;
}

type MyInvoice = Awaited<ReturnType<typeof myInvoices>>[number];

const STATUS_TEXT: Partial<Record<MyInvoice["status"], string>> = {
  pending_review: "In review",
  ready_to_send: "Queued to send",
  approved_unsent: "Approved, not sent",
  paid: "Paid",
  returned: "Returned",
};
const TURN_TEXT: Record<string, string> = { deputy: "Your turn", coordinator: "Coordinator's turn" };

/** The invoice's chip: whose turn while it is out, else where it stands. */
function statusChip(inv: MyInvoice): { tone: "success" | "danger" | "attention" | "neutral"; text: string } {
  let tone: "success" | "danger" | "attention" | "neutral" = "neutral";
  if (inv.status === "paid") tone = "success";
  else if (inv.status === "written_off") tone = "danger";
  else if (inv.turn === "deputy") tone = "attention";
  const text = inv.status === "sent" ? (TURN_TEXT[inv.turn ?? ""] ?? "Vendor's turn") : (STATUS_TEXT[inv.status] ?? "Written off");
  return { tone, text };
}

/** The staff view of any invoice, with the payee's own actions when it is their own. */
async function staffView(actor: Actor, id: string, now: Date) {
  const view = await withTx(async (tx) => {
    try {
      const inv = await staffInvoice(actor, tx, id, now);
      // Staff may handle their own invoices too; they also get the payee's own actions there.
      const own = inv.payeeUserId === actor.userId ? (await myInvoices(actor, tx, now, id))[0] : undefined;
      return { inv, issue: inv.issueId ? await getPaymentIssue(actor, tx, inv.issueId) : null, own, methods: own ? await activePaymentMethods(tx) : [] };
    } catch (e) {
      if (e instanceof NotFoundError) return "missing" as const;
      throw e;
    }
  });
  if (view === "missing") notFound();
  return (
    <StaffInvoice
      inv={view.inv}
      issue={view.issue}
      payeeActions={
        view.own ? (
          <InvoiceActions
            invoiceId={view.own.id}
            number={view.own.number}
            methods={view.methods}
            today={agencyDayKey(now)}
            canMark={(view.own.status === "sent" || view.own.status === "approved_unsent") && !view.own.deputyPaidAt}
            canReport={view.own.canReport}
            vendorSaysPaid={view.own.vendorPaidAt !== null}
          />
        ) : null
      }
    />
  );
}

/** Coordinators and admins get the staff view of any invoice; everyone else their own invoice with its timeline, the PDF and the payment actions. Links in alerts point here. */
export default async function InvoicePage({ params }: Readonly<Props>) {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  const { actor } = shell;
  const { id } = await params;
  if (actor.role === "vendor") redirect("/vendor/invoices");
  const now = new Date();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  if (staff) return staffView(actor, id, now);
  const data = await withTx(async (tx) => {
    const [inv] = await myInvoices(actor, tx, now, id);
    if (!inv) return null;
    try {
      return { inv, timeline: await invoiceTimeline(actor, tx, id), methods: await activePaymentMethods(tx) };
    } catch (e) {
      if (e instanceof DomainError) return null;
      throw e;
    }
  });
  if (!data) notFound();
  const { inv } = data;
  const chip = statusChip(inv);

  return (
    <div className="mx-auto flex w-full max-w-180 flex-col gap-4.5">
      <Link href="/billing?tab=waiting" className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        <Icon name="chevronLeft" size={18} />
        Back to billing
      </Link>
      <Card>
        <div className="flex flex-wrap items-center gap-1.5">
          <Chip tone={chip.tone}>{chip.text}</Chip>
        </div>
        <h1 className="m-0 text-2xl font-bold md:text-3xl">Invoice {inv.number}</h1>
        <dl className="m-0 grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold text-muted">Vendor</dt>
            <dd className="m-0">{inv.vendorName}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold text-muted">Detail</dt>
            <dd className="m-0">
              <Link href={`/jobs/${inv.jobNumber}`}>
                #{inv.jobNumber} {inv.jobTitle}
              </Link>
              , {dayLabel(inv.jobStartAt)}
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold text-muted">Amount</dt>
            <dd className="m-0">
              <PayLabel variant="plain" totalCents={inv.totalCents} rateCents={inv.rateCents} /> <span className="text-muted">for {hoursText(inv.minutes, true)}</span>
            </dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs font-semibold text-muted">Sent</dt>
            <dd className="m-0">{inv.sentAt ? dateLabel(inv.sentAt) : "Not sent yet"}</dd>
          </div>
        </dl>
        {invoiceSentence(inv, now).map((s) => (
          <p key={s} className="m-0 text-sm text-muted">
            {s}
          </p>
        ))}
        <InvoiceActions
          invoiceId={inv.id}
          number={inv.number}
          methods={data.methods}
          today={agencyDayKey(now)}
          canMark={(inv.status === "sent" || inv.status === "approved_unsent") && !inv.deputyPaidAt}
          canReport={inv.canReport}
          vendorSaysPaid={inv.vendorPaidAt !== null}
        />
        <a href={`/api/v1/invoices/${inv.id}/pdf`} className="inline-flex min-h-11 w-fit items-center gap-1.5 text-sm font-semibold" download>
          <Icon name="download" size={16} />
          Download PDF
        </a>
      </Card>
      <Card>
        <CardTitle>Timeline</CardTitle>
        {data.timeline.length === 0 ? (
          <p className="m-0 text-sm text-muted">Nothing has happened on this invoice yet.</p>
        ) : (
          <ol className="m-0 flex list-none flex-col gap-2.5 p-0">
            {[...data.timeline].reverse().map((e) => (
              <li key={e.id} className="grid grid-cols-[5.5rem_1fr] gap-3 text-sm">
                <span className="font-semibold" data-numeric>
                  {dateLabel(e.at).replace(/, \d{4}$/, "")}
                  <span className="block text-xs font-normal text-muted">{clock(e.at)}</span>
                </span>
                <span>{eventText(e)}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </div>
  );
}
