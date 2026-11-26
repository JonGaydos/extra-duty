import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { activePaymentMethods } from "@/domain/personnel/views";
import { agencyDayKey } from "@/domain/time/agency-time";
import { vendorInvoices, type VendorInvoiceRow } from "@/domain/vendor-portal/views";
import { Card } from "@/ui/components/Card";
import { Chip, type ChipTone } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { PayLabel, dollars } from "@/ui/components/PayLabel";
import { Icon } from "@/ui/icons";
import { dateLabel, dayLabel, hoursText, monthDay, plural } from "../../_personnel/format";
import { PageTitle } from "../../_personnel/TabLinks";
import { vendorActor } from "../_vendor/session";
import { MarkPaid } from "./MarkPaid";

export const metadata: Metadata = { title: "Invoices" };

const STATUS: Record<string, { text: string; tone: ChipTone }> = {
  sent: { text: "To pay", tone: "attention" },
  paid: { text: "Paid", tone: "success" },
  written_off: { text: "Closed", tone: "neutral" },
  returned: { text: "Withdrawn", tone: "neutral" },
};

function chip(i: VendorInvoiceRow): { text: string; tone: ChipTone } {
  if (i.status === "sent" && i.vendorPaid) return { text: "You marked paid", tone: "info" };
  return STATUS[i.status] ?? { text: "Sent", tone: "neutral" };
}

/** "You marked this paid on Dec 3 by Ramp, #1042." */
function paidSentence(i: VendorInvoiceRow): string | null {
  if (!i.vendorPaid) return null;
  const method = i.vendorPaid.method ? ` by ${i.vendorPaid.method}` : "";
  const reference = i.vendorPaid.reference ? `, #${i.vendorPaid.reference}` : "";
  return `You marked this paid on ${monthDay(i.vendorPaid.at)}${method}${reference}.`;
}

function InvoiceCard({ i, methods, today }: Readonly<{ i: VendorInvoiceRow; methods: Array<{ id: string; name: string }>; today: string }>) {
  const c = chip(i);
  const paid = paidSentence(i);
  return (
    <Card as="article" aria-labelledby={`inv-${i.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h3 id={`inv-${i.id}`} className="m-0 text-title font-semibold md:text-base">
            Invoice <span data-numeric>{i.number}</span>
          </h3>
          <p className="m-0 text-sm text-muted">
            From {i.payeeName}. Sent {dateLabel(i.sentAt)}.
          </p>
        </div>
        <span className="flex flex-wrap gap-1.5">
          {i.kind === "late_cancel" ? <Chip tone="warning">Late cancellation</Chip> : null}
          <Chip tone={c.tone}>{c.text}</Chip>
        </span>
      </div>
      <dl className="m-0 grid gap-3 border-t border-divider pt-3 sm:grid-cols-2">
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-semibold text-muted">Detail</dt>
          <dd className="m-0 flex flex-col">
            <span className="font-semibold">{i.jobTitle}</span>
            <span className="text-sm text-muted">
              {dayLabel(i.jobStartAt)}, <span data-numeric>#{i.jobNumber}</span>
            </span>
          </dd>
        </div>
        <div className="flex flex-col gap-0.5">
          <dt className="text-xs font-semibold text-muted">Amount</dt>
          <dd className="m-0 flex flex-col gap-0.5">
            <PayLabel variant="plain" totalCents={i.totalCents} rateCents={i.rateCents} />
            <span className="text-sm text-muted">For {hoursText(i.minutes, true)}. {i.status === "paid" ? "Paid." : "Pay the deputy directly."}</span>
          </dd>
        </div>
      </dl>
      {paid ? <p className="m-0 text-sm">{paid} The deputy confirms when the money arrives.</p> : null}
      {i.status === "paid" && i.deputyPaidAt ? <p className="m-0 text-sm">The deputy confirmed payment on {monthDay(i.deputyPaidAt)}.</p> : null}
      <div className="flex flex-wrap items-center gap-x-4 border-t border-divider pt-1">
        <a href={`/api/v1/invoices/${i.id}/pdf`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold">
          Download PDF<span className="sr-only">, invoice {i.number}</span>
          <Icon name="download" size={16} />
        </a>
      </div>
      {i.status === "sent" ? <MarkPaid invoiceId={i.id} number={i.number} methods={methods} today={today} canMark={!i.vendorPaid} /> : null}
    </Card>
  );
}

/** Invoices deputies sent to the vendor, to pay and to mark paid on the vendor's side (12.8). */
export default async function VendorInvoicesPage() {
  const actor = await vendorActor();
  const data = await withTx(async (tx) => ({ rows: await vendorInvoices(actor, tx), methods: await activePaymentMethods(tx) }));
  const today = agencyDayKey(new Date());
  // One list, invoices to pay first: an invoice keeps its place in the list (and its result message) when marked paid.
  const toPay = data.rows.filter((i) => i.status === "sent" && !i.vendorPaid);
  const ordered = [...toPay, ...data.rows.filter((i) => !toPay.includes(i))];
  const owed = toPay.reduce((n, i) => n + i.totalCents, 0);

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub="Deputies bill you directly. Pay each deputy, then mark the invoice paid here.">Invoices</PageTitle>
      {data.rows.length === 0 ? (
        <Card pad={false}>
          <EmptyState title="No invoices yet">Invoices show here once a deputy bills a detail and it is sent to you.</EmptyState>
        </Card>
      ) : (
        <section aria-labelledby="invoices-heading" className="flex flex-col gap-2.5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="invoices-heading" className="m-0 text-title font-semibold md:text-base">
              Sent to you
            </h2>
            <p className="m-0 text-sm text-muted" data-numeric>
              {toPay.length ? `${plural(toPay.length, "invoice")} to pay, ${dollars(owed)} in all.` : "Nothing to pay. Every invoice is marked paid."}
            </p>
          </div>
          <div className="flex flex-col gap-3">
            {ordered.map((i) => (
              <InvoiceCard key={i.id} i={i} methods={data.methods} today={today} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
