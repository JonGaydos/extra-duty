import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { billingHistory } from "@/domain/billing/history";
import { activePaymentMethods, myInvoices, toBill, upcomingLateCancels, type MyInvoice } from "@/domain/personnel/views";
import { lateCancelBillableText } from "@/domain/billing/rules";
import { agencyDayKey } from "@/domain/time/agency-time";
import { Button, ButtonLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { dollars, PayLabel } from "@/ui/components/PayLabel";
import { StatTile } from "@/ui/components/StatTile";
import { Table } from "@/ui/components/Table";
import { Icon } from "@/ui/icons";
import { dayLabel, hoursText, plural, timeRange } from "../_personnel/format";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { InvoiceActions } from "./InvoiceActions";
import { invoiceSentence } from "../_personnel/invoice-text";

export const metadata: Metadata = { title: "Billing" };

type Tab = "bill" | "waiting" | "paid" | "history";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TURN: Record<string, { tone: "attention" | "neutral" | "coordinator"; text: string }> = {
  deputy: { tone: "attention", text: "Your turn" },
  vendor: { tone: "neutral", text: "Vendor's turn" },
  coordinator: { tone: "coordinator", text: "Coordinator's turn" },
};

function InvoiceCard({ i, now, methods, today }: { i: MyInvoice; now: Date; methods: Array<{ id: string; name: string }>; today: string }) {
  const turn = i.status === "sent" && i.turn ? TURN[i.turn] : null;
  return (
    <Card as="article" aria-label={`${i.number}, ${i.vendorName}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        {turn ? <Chip tone={turn.tone}>{turn.text}</Chip> : <Chip tone={i.status === "paid" ? "success" : i.status === "written_off" ? "danger" : "warning"}>{i.status === "paid" ? "Paid" : i.status === "written_off" ? "Written off" : i.status === "returned" ? "Returned" : i.status === "ready_to_send" ? "Queued to send" : i.status === "approved_unsent" ? "Approved, not sent" : "In review"}</Chip>}
        <Chip>{i.number}</Chip>
      </div>
      <div className="flex items-start justify-between gap-3">
        <span className="flex flex-col">
          <b>{i.vendorName}</b>
          <span className="text-sm text-muted">
            {i.jobTitle}, {dayLabel(i.jobStartAt)}, {hoursText(i.minutes, true)}
          </span>
        </span>
        <PayLabel variant="plain" totalCents={i.totalCents} rateCents={i.rateCents} />
      </div>
      {invoiceSentence(i, now).map((s) => (
        <p key={s} className="m-0 text-sm text-muted">
          {s}
        </p>
      ))}
      <InvoiceActions
        invoiceId={i.id}
        number={i.number}
        methods={methods}
        today={today}
        canMark={(i.status === "sent" || i.status === "approved_unsent") && !i.deputyPaidAt}
        canReport={i.canReport}
        vendorSaysPaid={i.vendorPaidAt !== null}
      />
      <Link href={`/invoices/${i.id}`} className="inline-flex min-h-11 w-fit items-center gap-1 text-sm font-semibold">
        Invoice and timeline
        <Icon name="chevronRight" size={16} />
      </Link>
    </Card>
  );
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Billed by month for the last 12 months: one series, so no legend; every bar has its amount on hover and in the table below. */
function MonthChart({ byMonth, now }: { byMonth: Array<{ month: string; earnedCents: number }>; now: Date }) {
  const [y, m] = agencyDayKey(now).split("-").map(Number);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 12 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return { key, label: MONTHS[d.getUTCMonth()], year: d.getUTCFullYear(), cents: byMonth.find((b) => b.month === key)?.earnedCents ?? 0 };
  });
  const max = Math.max(1, ...months.map((x) => x.cents));
  const top = months.reduce((a, b) => (b.cents > a.cents ? b : a), months[0]);
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div
        role="img"
        aria-label={`Billed by month for the last 12 months${top.cents ? `, highest ${dollars(top.cents)} in ${top.label} ${top.year}` : ", nothing billed yet"}`}
        className="flex h-36 items-end gap-0.5 border-b border-line md:h-44"
      >
        {months.map((x) => (
          <div key={x.key} title={`${x.label} ${x.year}: ${dollars(x.cents)}`} className="group flex h-full flex-1 flex-col justify-end px-px hover:bg-subtle">
            {x.cents > 0 ? <div className="mx-auto w-full max-w-10 rounded-t-xs bg-accent group-hover:bg-accent-hover" style={{ height: `${Math.max(2, (x.cents / max) * 100)}%` }} /> : null}
          </div>
        ))}
      </div>
      <div aria-hidden className="flex gap-0.5">
        {months.map((x) => (
          <span key={x.key} className="flex-1 text-center text-micro text-muted">
            {x.label[0]}
          </span>
        ))}
      </div>
      <figcaption className="text-xs text-muted">
        {months[0].label} {months[0].year} to {months[11].label} {months[11].year}. The table below lists every invoice.
      </figcaption>
    </figure>
  );
}

/** To bill, waiting on payment, paid, and history with totals, a chart and CSV export. */
export default async function BillingPage({ searchParams }: Props) {
  const actor = await personnelActor();
  const sp = await searchParams;
  const now = new Date();
  const data = await withTx(async (tx) => ({
    bill: await toBill(actor, tx, now),
    upcoming: await upcomingLateCancels(actor, tx, now),
    invoices: await myInvoices(actor, tx, now),
    // Always the person's own invoices here, staff included; agency-wide history lives on staff pages.
    history: await billingHistory(actor, tx, { payeeUserId: actor.userId }),
    methods: await activePaymentMethods(tx),
  }));
  const waiting = data.invoices.filter((i) => i.status === "sent" || i.status === "pending_review" || i.status === "ready_to_send" || i.status === "approved_unsent" || i.status === "returned");
  const paid = data.invoices.filter((i) => i.status === "paid" || i.status === "written_off");
  const asked = (Array.isArray(sp.tab) ? sp.tab[0] : sp.tab) as Tab | undefined;
  const tab: Tab = asked && ["bill", "waiting", "paid", "history"].includes(asked) ? asked : data.bill.length > 0 || data.upcoming.length > 0 ? "bill" : "waiting";
  const today = agencyDayKey(now);
  const t = data.history.totals;

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          <Link href="/billing/earnings" className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold">
            Earnings and tax summary
            <Icon name="chevronRight" size={16} />
          </Link>
        }
      >
        Billing
      </PageTitle>
      <TabLinks
        label="Billing sections"
        current={tab}
        items={[
          { key: "bill", label: `To bill (${data.bill.length})`, href: "/billing?tab=bill" },
          { key: "waiting", label: `Waiting (${waiting.length})`, href: "/billing?tab=waiting" },
          { key: "paid", label: "Paid", href: "/billing?tab=paid" },
          { key: "history", label: "History", href: "/billing?tab=history" },
        ]}
      />

      {tab === "bill" && data.upcoming.length > 0 ? (
        <div className="grid gap-3 md:grid-cols-2" aria-label="Late cancellations to bill later">
          {data.upcoming.map((b) => {
            const after = lateCancelBillableText(b.jobEndAt);
            return (
              <Card as="article" key={b.assignmentId} aria-label={`${b.vendorName}, ${b.title}`}>
                <Chip tone="warning">Late cancellation, paid</Chip>
                <div className="flex items-start justify-between gap-3">
                  <span className="flex flex-col">
                    <b>{b.vendorName}</b>
                    <span className="text-sm text-muted">
                      #{b.jobNumber} {b.title}, {dayLabel(b.startAt)}, {timeRange(b.startAt, b.endAt)}
                    </span>
                  </span>
                  <PayLabel totalCents={b.totalCents} rateCents={b.rateCents} />
                </div>
                <p className="m-0 text-sm text-muted" id={`bill-after-${b.assignmentId}`}>
                  {after}.
                </p>
                <Button size="lg" full disabled aria-describedby={`bill-after-${b.assignmentId}`}>
                  Review and send invoice
                </Button>
              </Card>
            );
          })}
        </div>
      ) : null}

      {tab === "bill" ? (
        data.bill.length === 0 ? (
          data.upcoming.length > 0 ? null : (
          <Card pad={false}>
            <EmptyState title="Nothing to bill">Details you work show here once they end.</EmptyState>
          </Card>
          )
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {data.bill.map((b) => (
              <Card as="article" key={b.assignmentId} tone="accent" aria-label={`${b.vendorName}, ${b.title}`}>
                {b.lateCancel ? <Chip tone="warning">Late cancellation, paid</Chip> : null}
                <div className="flex items-start justify-between gap-3">
                  <span className="flex flex-col">
                    <b>{b.vendorName}</b>
                    <span className="text-sm text-muted">
                      #{b.jobNumber} {b.title}, {dayLabel(b.startAt)}, {timeRange(b.startAt, b.endAt)}
                    </span>
                  </span>
                  <PayLabel totalCents={b.totalCents} rateCents={b.rateCents} />
                </div>
                <ButtonLink href={`/billing/bill/${b.assignmentId}`} size="lg" full>
                  Review and send invoice
                </ButtonLink>
              </Card>
            ))}
          </div>
        )
      ) : null}

      {tab === "waiting" || tab === "paid" ? (
        (tab === "waiting" ? waiting : paid).length === 0 ? (
          <Card pad={false}>
            <EmptyState title={tab === "waiting" ? "Nothing waiting" : "No paid invoices yet"}>
              {tab === "waiting" ? "Invoices you send show here until you are paid." : "Invoices you mark received show here."}
            </EmptyState>
          </Card>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {(tab === "waiting" ? waiting : paid).map((i) => (
              <InvoiceCard key={i.id} i={i} now={now} methods={data.methods} today={today} />
            ))}
          </div>
        )
      ) : null}

      {tab === "history" ? (
        <div className="flex flex-col gap-4.5">
          <div className="grid grid-cols-2 gap-2.5 md:grid-cols-4">
            <StatTile label="Billed" value={dollars(t.earnedCents)} />
            <StatTile label="Paid" value={dollars(t.paidCents)} />
            <StatTile label="Waiting" value={dollars(t.waitingCents)} />
            <StatTile label="Hours" value={hoursText(t.minutes)} unit={`on ${plural(t.count, "invoice")}`} />
          </div>
          <Card>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <CardTitle>Billed by month</CardTitle>
              <a href={`/api/v1/billing/history/export?payeeUserId=${encodeURIComponent(actor.userId)}`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold" download>
                <Icon name="download" size={16} />
                Download CSV
              </a>
            </div>
            <MonthChart byMonth={data.history.byMonth} now={now} />
          </Card>
          <Table
            caption="All invoices"
            columns={[
              { header: "Invoice", cell: (r) => <Link className="whitespace-nowrap" href={`/invoices/${r.invoiceId}`}>{data.invoices.find((i) => i.id === r.invoiceId)?.number ?? r.number}</Link> },
              { header: "Vendor", cell: (r) => r.vendorName },
              { header: "Date", cell: (r) => dayLabel(r.jobStartAt) },
              { header: "Hours", cell: (r) => hoursText(r.minutes), align: "end" },
              { header: "Amount", cell: (r) => <PayLabel variant="plain" totalCents={r.totalCents} rateCents={r.rateCents} />, align: "end" },
              { header: "Status", cell: (r) => r.status.replace("_", " ").replace(/^./, (c) => c.toUpperCase()) },
            ]}
            rows={[...data.history.rows].reverse()}
            rowKey={(r) => r.invoiceId}
            empty="No invoices yet."
          />
        </div>
      ) : null}
    </div>
  );
}
