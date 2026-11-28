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
import { needsAttention } from "@/domain/billing/banner";

export const metadata: Metadata = { title: "Billing" };

type Tab = "bill" | "waiting" | "paid" | "history";
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const TURN: Record<string, { tone: "attention" | "neutral" | "coordinator"; text: string }> = {
  deputy: { tone: "attention", text: "Your turn" },
  vendor: { tone: "neutral", text: "Vendor's turn" },
  coordinator: { tone: "coordinator", text: "Coordinator's turn" },
};

const STATUS_CHIP: Partial<Record<MyInvoice["status"], { tone: "success" | "danger" | "warning"; text: string }>> = {
  paid: { tone: "success", text: "Paid" },
  written_off: { tone: "danger", text: "Written off" },
  returned: { tone: "warning", text: "Returned" },
  ready_to_send: { tone: "warning", text: "Queued to send" },
  approved_unsent: { tone: "warning", text: "Approved, not sent" },
};
const IN_REVIEW = { tone: "warning", text: "In review" } as const;

function InvoiceCard({ i, now, methods, today }: Readonly<{ i: MyInvoice; now: Date; methods: Array<{ id: string; name: string }>; today: string }>) {
  const turn = i.status === "sent" && i.turn ? TURN[i.turn] : null;
  const chip = turn ?? STATUS_CHIP[i.status] ?? IN_REVIEW;
  return (
    <Card as="article" aria-label={`${i.number}, ${i.vendorName}`}>
      <div className="flex flex-wrap items-center gap-1.5">
        <Chip tone={chip.tone}>{chip.text}</Chip>
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
function MonthChart({ byMonth, now }: Readonly<{ byMonth: Array<{ month: string; earnedCents: number }>; now: Date }>) {
  const [y, m] = agencyDayKey(now).split("-").map(Number);
  const months = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(Date.UTC(y, m - 12 + i, 1));
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
    return { key, label: MONTHS[d.getUTCMonth()], year: d.getUTCFullYear(), cents: byMonth.find((b) => b.month === key)?.earnedCents ?? 0 };
  });
  const max = Math.max(1, ...months.map((x) => x.cents));
  const top = months.reduce((a, b) => (b.cents > a.cents ? b : a), months[0]);
  const highest = top.cents ? `, highest ${dollars(top.cents)} in ${top.label} ${top.year}` : ", nothing billed yet";
  return (
    <figure className="m-0 flex flex-col gap-2">
      <div
        role="img"
        aria-label={`Billed by month for the last 12 months${highest}`}
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

type Upcoming = Awaited<ReturnType<typeof upcomingLateCancels>>;
type ToBill = Awaited<ReturnType<typeof toBill>>;
type History = Awaited<ReturnType<typeof billingHistory>>;
type Methods = Array<{ id: string; name: string }>;

const TABS: readonly Tab[] = ["bill", "waiting", "paid", "history"];

/** The asked tab, or To bill when there is something to bill (or bill later), else Waiting. */
function pickTab(asked: Tab | undefined, hasToBill: boolean): Tab {
  if (asked && TABS.includes(asked)) return asked;
  return hasToBill ? "bill" : "waiting";
}

/** Late cancellations that are paid but cannot be billed until the detail would have ended. */
function LateCancelsLater({ upcoming }: Readonly<{ upcoming: Upcoming }>) {
  return (
    <div className="grid gap-3 md:grid-cols-2" aria-label="Late cancellations to bill later">
      {upcoming.map((b) => {
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
  );
}

/** Ended details to bill, each with its pay and a link to the bill form. */
function ToBillList({ bill, upcoming }: Readonly<{ bill: ToBill; upcoming: Upcoming }>) {
  if (bill.length === 0) {
    if (upcoming.length > 0) return null;
    return (
      <Card pad={false}>
        <EmptyState title="Nothing to bill">Details you work show here once they end.</EmptyState>
      </Card>
    );
  }
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {bill.map((b) => (
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
  );
}

/** The Waiting or Paid invoices as cards, or what will show here. */
function InvoiceList({ tab, list, now, methods, today }: Readonly<{ tab: "waiting" | "paid"; list: MyInvoice[]; now: Date; methods: Methods; today: string }>) {
  if (list.length === 0)
    return (
      <Card pad={false}>
        <EmptyState title={tab === "waiting" ? "Nothing waiting" : "No paid invoices yet"}>
          {tab === "waiting" ? "Invoices you send show here until you are paid." : "Invoices you mark received show here."}
        </EmptyState>
      </Card>
    );
  return (
    <div className="grid gap-3 md:grid-cols-2">
      {list.map((i) => (
        <InvoiceCard key={i.id} i={i} now={now} methods={methods} today={today} />
      ))}
    </div>
  );
}

/** Totals, the monthly chart with CSV export, and every invoice in a table. */
function HistoryTab({ userId, history, invoices, now }: Readonly<{ userId: string; history: History; invoices: MyInvoice[]; now: Date }>) {
  const t = history.totals;
  return (
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
          <a href={`/api/v1/billing/history/export?payeeUserId=${encodeURIComponent(userId)}`} className="inline-flex min-h-11 items-center gap-1 text-sm font-semibold" download>
            <Icon name="download" size={16} />
            Download CSV
          </a>
        </div>
        <MonthChart byMonth={history.byMonth} now={now} />
      </Card>
      <Table
        caption="All invoices"
        columns={[
          { header: "Invoice", render: (r) => <Link className="whitespace-nowrap" href={`/invoices/${r.invoiceId}`}>{invoices.find((i) => i.id === r.invoiceId)?.number ?? r.number}</Link> },
          { header: "Vendor", render: (r) => r.vendorName },
          { header: "Date", render: (r) => dayLabel(r.jobStartAt) },
          { header: "Hours", render: (r) => hoursText(r.minutes), align: "end" },
          { header: "Amount", render: (r) => <PayLabel variant="plain" totalCents={r.totalCents} rateCents={r.rateCents} />, align: "end" },
          { header: "Status", render: (r) => r.status.replace("_", " ").replace(/^./, (c) => c.toUpperCase()) },
        ]}
        rows={[...history.rows].reverse()}
        rowKey={(r) => r.invoiceId}
        empty="No invoices yet."
      />
    </div>
  );
}

/** To bill, waiting on payment, paid, and history with totals, a chart and CSV export. */
export default async function BillingPage({ searchParams }: Readonly<Props>) {
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
  // From Home's banner: only the invoices that wait on the person.
  const needs = sp.needs === "1";
  const attention = waiting.filter(needsAttention);
  const waitingShown = needs ? attention : waiting;
  const asked = (Array.isArray(sp.tab) ? sp.tab[0] : sp.tab) as Tab | undefined;
  const tab = pickTab(asked, data.bill.length > 0 || data.upcoming.length > 0);
  const today = agencyDayKey(now);

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

      {tab === "bill" && data.upcoming.length > 0 ? <LateCancelsLater upcoming={data.upcoming} /> : null}

      {tab === "bill" ? <ToBillList bill={data.bill} upcoming={data.upcoming} /> : null}

      {tab === "waiting" && needs ? (
        <p className="m-0 flex flex-wrap items-center gap-x-3 text-sm" data-testid="needs-filter">
          <span>
            Showing the {attention.length === 1 ? "invoice that needs" : `${attention.length} invoices that need`} your attention.
          </span>
          <Link href="/billing?tab=waiting" className="inline-flex min-h-11 items-center font-semibold">
            Show all waiting
          </Link>
        </p>
      ) : null}

      {tab === "waiting" || tab === "paid" ? <InvoiceList tab={tab} list={tab === "paid" ? paid : waitingShown} now={now} methods={data.methods} today={today} /> : null}

      {tab === "history" ? <HistoryTab userId={actor.userId} history={data.history} invoices={data.invoices} now={now} /> : null}
    </div>
  );
}
