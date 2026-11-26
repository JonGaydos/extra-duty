import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { paymentsBoard, staffInvoice, unsentInvoices, type BoardRow } from "@/domain/coordinator/views";
import { NotFoundError } from "@/domain/errors";
import type { Party } from "@/domain/billing/payments";
import { ButtonLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { dollars } from "@/ui/components/PayLabel";
import { StatTile } from "@/ui/components/StatTile";
import { Table } from "@/ui/components/Table";
import { PageTitle, TabLinks } from "../../_personnel/TabLinks";
import { clock, dateLabel, plural, prefixed } from "../../_personnel/format";
import { coordinatorActor } from "../_coordinator/session";
import { turnChip } from "../../invoices/[id]/StaffInvoice";
import { SendNowButton } from "../TodoActions";
import { InvoicePdfLink } from "../../invoices/[id]/InvoicePdfLink";
import { eventLabel } from "../../invoices/[id]/invoice-events";

export const metadata: Metadata = { title: "Payments" };

/** "In review, " or "Late cancellation, " before the days waited. */
function waitingPrefix(r: { status: string; kind: string }): string {
  if (r.status === "pending_review") return "In review, ";
  return r.kind === "late_cancel" ? "Late cancellation, " : "";
}

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const FILTERS = {
  all: { label: "All", test: () => true },
  overdue: { label: "Overdue", test: (r: BoardRow) => r.overdue },
  vendorPaid: { label: "Vendor reports paid", test: (r: BoardRow) => r.vendorReportsPaid },
  hold: { label: "Vendor on hold", test: (r: BoardRow) => r.vendorOnHold },
} as const;
type Filter = keyof typeof FILTERS;

const GROUPS: Array<{ party: Party; title: string }> = [
  { party: "coordinator", title: "Coordinator's turn" },
  { party: "deputy", title: "Deputy's turn" },
  { party: "vendor", title: "Vendor's turn" },
];

/**
 * Every unpaid invoice, grouped by whose turn it is (coordinator, deputy, vendor), with days waiting against the
 * response time. Choosing one shows its timeline beside the list.
 */
export default async function PaymentsPage({ searchParams }: Readonly<Props>) {
  const actor = await coordinatorActor();
  const sp = await searchParams;
  const filter: Filter = typeof sp.filter === "string" && sp.filter in FILTERS ? (sp.filter as Filter) : "all";
  const openId = typeof sp.open === "string" ? sp.open : null;
  const now = new Date();
  const { board, open, unsent } = await withTx(async (tx) => {
    const board = await paymentsBoard(actor, tx, now);
    const unsent = await unsentInvoices(actor, tx);
    let open = null;
    if (openId) {
      try {
        open = await staffInvoice(actor, tx, openId, now);
      } catch (e) {
        if (!(e instanceof NotFoundError)) throw e;
      }
    }
    return { board, open, unsent };
  });
  const rows = board.rows.filter(FILTERS[filter].test);
  const href = (f: Filter, o?: string | null) => `/coordinate/payments?filter=${f}${prefixed("&open=", o)}`;

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        sub="Unpaid invoices by who has to act next."
        action={
          <ButtonLink href="/coordinate/send-invoices" variant="secondary">
            Send invoices
          </ButtonLink>
        }
      >
        Payments
      </PageTitle>
      <div className="grid gap-2.5 sm:grid-cols-3">
        {[
          ["Vendor's turn", board.totals.vendor],
          ["Deputy's turn", board.totals.deputy],
          ["Coordinator's turn", board.totals.coordinator],
        ].map(([label, t]) => {
          const x = t as (typeof board.totals)["vendor"];
          return (
            <div key={label as string} className="flex flex-col gap-1">
              <StatTile label={label as string} value={dollars(x.cents)} tone={x.overdue > 0 ? "warning" : "default"} />
              <span className="px-1 text-xs text-muted" data-numeric>
                {plural(x.count, "invoice")}
                {x.overdue ? `, ${x.overdue} overdue` : ""}
              </span>
            </div>
          );
        })}
      </div>
      <TabLinks
        label="Show"
        current={filter}
        items={(Object.keys(FILTERS) as Filter[]).map((f) => ({ key: f, label: `${FILTERS[f].label} ${board.rows.filter(FILTERS[f].test).length}`, href: href(f) }))}
      />
      <div className="grid gap-4.5 lg:grid-cols-[minmax(0,1fr)_360px] lg:items-start">
        <div className="flex min-w-0 flex-col gap-4.5">
          {rows.length === 0 ? (
            <Card pad={false}>
              <EmptyState title="Nothing here">No unpaid invoices match this view.</EmptyState>
            </Card>
          ) : (
            GROUPS.map((g) => {
              const list = rows.filter((r) => r.party === g.party);
              if (list.length === 0) return null;
              return (
                <Table
                  key={g.party}
                  caption={`${g.title} (${list.length})`}
                  rows={list}
                  rowKey={(r) => r.invoiceId}
                  columns={[
                    {
                      header: "Invoice",
                      render: (r) => (
                        <Link href={href(filter, r.invoiceId)} aria-current={r.invoiceId === openId ? "true" : undefined} className="font-semibold whitespace-nowrap">
                          {r.number}
                        </Link>
                      ),
                    },
                    { header: "Deputy", render: (r) => r.payeeName },
                    {
                      header: "Vendor",
                      render: (r) => (
                        <span className="flex flex-col gap-1">
                          {r.vendorName}
                          {r.vendorOnHold ? <Chip tone="danger">On hold</Chip> : null}
                          {r.vendorReportsPaid ? <Chip tone="info">Reports paid</Chip> : null}
                        </span>
                      ),
                    },
                    { header: "Amount", render: (r) => dollars(r.totalCents), align: "end" },
                    {
                      header: "Waiting",
                      align: "end",
                      render: (r) => (
                        <span className={r.overdue ? "font-semibold whitespace-nowrap text-danger-ink" : "whitespace-nowrap"}>
                          {waitingPrefix(r)}
                          {r.day} of {r.limitDays} days
                          {r.overdue ? ", overdue" : ""}
                        </span>
                      ),
                    },
                    { header: "PDF", render: (r) => <InvoicePdfLink id={r.invoiceId} number={r.number} compact /> },
                  ]}
                />
              );
            })
          )}
          {filter === "all" && unsent.length ? (
            <Table
              caption={`Approved, not sent (${unsent.length})`}
              rows={unsent}
              rowKey={(r) => r.id}
              columns={[
                {
                  header: "Invoice",
                  render: (r) => (
                    <Link href={href(filter, r.id)} aria-current={r.id === openId ? "true" : undefined} className="font-semibold whitespace-nowrap">
                      {r.number}
                    </Link>
                  ),
                },
                { header: "Deputy", render: (r) => r.payeeName },
                { header: "Vendor", render: (r) => r.vendorName },
                { header: "Amount", render: (r) => dollars(r.totalCents), align: "end" },
                { header: "Deputy paid", render: (r) => (r.deputyPaid ? "Yes" : "No") },
                { header: "PDF", render: (r) => <InvoicePdfLink id={r.id} number={r.number} compact /> },
                { header: "Action", render: (r) => <SendNowButton invoiceId={r.id} number={r.number} /> },
              ]}
            />
          ) : null}
        </div>
        {open ? (
          <Card className="lg:sticky lg:top-6" aria-labelledby="open-invoice">
            <div className="flex flex-wrap items-center gap-1.5">
              <Chip tone={turnChip(open.status, open.party, open.overdue).tone}>{turnChip(open.status, open.party, open.overdue).text}</Chip>
            </div>
            <h2 id="open-invoice" className="m-0 text-title font-semibold md:text-base">
              {open.number}
            </h2>
            <p className="m-0 text-sm">
              {open.payeeName} for {open.vendorName}, {open.jobTitle}, {dollars(open.totalCents)}.{open.vendorOnHold ? " Vendor on payment hold." : ""}
            </p>
            <CardTitle as="h3">Timeline</CardTitle>
            <ol className="m-0 flex list-none flex-col gap-2 p-0 text-sm">
              {[...open.timeline].reverse().map((e) => (
                <li key={e.id} className="grid grid-cols-[4.5rem_1fr] gap-2">
                  <span className="font-semibold" data-numeric>
                    {dateLabel(e.at).replace(/, \d{4}$/, "")}
                    <span className="block text-xs font-normal text-muted">{clock(e.at)}</span>
                  </span>
                  <span>
                    {e.actorName ? `${e.actorName}: ` : ""}
                    {eventLabel(e.event)}
                    {e.event === "issue_waiting_on" && e.party ? ` the ${e.party}` : ""}
                    {e.note ? `. ${e.note}` : ""}
                  </span>
                </li>
              ))}
              {open.timeline.length === 0 ? <li className="text-muted">Nothing yet.</li> : null}
            </ol>
            <ButtonLink href={`/invoices/${open.id}`} className="w-fit">
              Work this invoice
            </ButtonLink>
          </Card>
        ) : null}
      </div>
    </div>
  );
}
