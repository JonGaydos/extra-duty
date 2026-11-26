import { withTx } from "@/ui/shell/request";
import { earningsDashboard } from "@/domain/reports/earnings";
import { taxYearSummary } from "@/domain/reports/tax";
import { agencyDateParts } from "@/domain/time/agency-time";
import { Card, CardTitle } from "@/ui/components/Card";
import { Notice } from "@/ui/components/Notice";
import { dollars } from "@/ui/components/PayLabel";
import { StatTile } from "@/ui/components/StatTile";
import { Table } from "@/ui/components/Table";
import { Icon } from "@/ui/icons";
import { dateLabel, hoursText, plural } from "../../_personnel/format";
import type { Actor } from "@/domain/actor";
import { TaxYearPicker } from "./TaxYearPicker";

/**
 * One person's earnings: this month, this year, outstanding, year by year, and a tax summary per year with PDF and
 * CSV downloads. The person's own page and the coordinators' deputy lookup share it; the services decide access.
 */
export async function EarningsView({ actor, userId, asked, path, back }: Readonly<{ actor: Actor; userId: string; asked: number; path: string; back: React.ReactNode }>) {
  const now = new Date();
  const thisYear = agencyDateParts(now).year;
  const self = userId === actor.userId;
  const who = self ? "you" : "the deputy";
  const forUser = self ? "" : `&userId=${userId}`;
  const data = await withTx(async (tx) => {
    const dash = await earningsDashboard(actor, tx, userId, now);
    const years = [...new Set([thisYear, ...dash.byYear.map((y) => y.year)])].sort((a, b) => b - a);
    const year = years.includes(asked) ? asked : thisYear;
    return { dash, years, year, tax: await taxYearSummary(actor, tx, userId, year) };
  });
  const { dash, tax } = data;
  const mismatches = tax.rows.filter((r) => r.yearMismatch);
  const month = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", month: "long" }).format(now);

  return (
    <div className="flex flex-col gap-4.5">
      {back}
      <div className="grid grid-cols-2 gap-2.5 md:grid-cols-3">
        <div className="flex flex-col gap-1">
          <StatTile label={month} value={dollars(dash.thisMonth.billedCents)} />
          <span className="px-1 text-xs text-muted" data-numeric>
            {dollars(dash.thisMonth.paidCents)} paid, {hoursText(dash.thisMonth.minutes)}
          </span>
        </div>
        <div className="flex flex-col gap-1">
          <StatTile label={`${thisYear} so far`} value={dollars(dash.thisYear.billedCents)} />
          <span className="px-1 text-xs text-muted" data-numeric>
            {dollars(dash.thisYear.paidCents)} paid, {hoursText(dash.thisYear.minutes)}
          </span>
        </div>
        <StatTile label="Outstanding" value={dollars(dash.outstandingCents)} />
      </div>

      <div className="grid gap-4.5 md:grid-cols-2 md:items-start md:gap-6">
        <Table
          caption="Year by year"
          columns={[
            { header: "Year", render: (r) => String(r.year) },
            { header: "Details", render: (r) => String(r.details), align: "end" },
            { header: "Hours", render: (r) => hoursText(r.minutes), align: "end" },
            { header: "Billed", render: (r) => dollars(r.billedCents), align: "end" },
            { header: "Received", render: (r) => dollars(r.paidCents), align: "end" },
          ]}
          rows={dash.byYear}
          rowKey={(r) => String(r.year)}
          empty="Nothing billed yet."
        />

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Tax summary</CardTitle>
            <TaxYearPicker years={data.years} year={data.year} path={path} />
          </div>
          <p className="m-0 text-sm text-muted">Counted in the year {who} marked payment received. Not tax advice.</p>
          {tax.byVendor.length === 0 ? (
            <p className="m-0 text-sm">No payments received in {data.year}.</p>
          ) : (
            <dl className="m-0 grid grid-cols-[1fr_auto] gap-x-4 gap-y-2" data-numeric>
              {tax.byVendor.map((v) => (
                <div key={v.vendorId} className="contents">
                  <dt>{v.vendorName}</dt>
                  <dd className="m-0 text-right">{dollars(v.paidCents)}</dd>
                </div>
              ))}
              <dt className="border-t border-divider pt-2 font-semibold">Total received</dt>
              <dd className="m-0 border-t border-divider pt-2 text-right font-bold">{dollars(tax.totalPaidCents)}</dd>
            </dl>
          )}
          {tax.unpaidBilledCents > 0 ? <p className="m-0 text-sm text-muted">Billed in {data.year} and not yet received: {dollars(tax.unpaidBilledCents)}.</p> : null}
          {mismatches.length > 0 ? (
            <Notice tone="warning">
              {plural(mismatches.length, "payment straddles", "payments straddle")} the year
              {mismatches[0].vendorPaidAt && mismatches[0].paidAt ? `: vendor paid ${dateLabel(mismatches[0].vendorPaidAt)}, ${who} received ${dateLabel(mismatches[0].paidAt)}` : ""}. Check it against their 1099.
            </Notice>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <a href={`/api/v1/reports/tax/${data.year}/export?format=pdf${forUser}`} data-button-link className="inline-flex h-11 items-center gap-2 rounded-md border border-line bg-surface px-4 font-semibold text-ink no-underline hover:bg-subtle hover:text-ink" download>
              <Icon name="download" size={18} />
              Download PDF
            </a>
            <a href={`/api/v1/reports/tax/${data.year}/export?format=csv${forUser}`} data-button-link className="inline-flex h-11 items-center gap-2 rounded-md border border-line bg-surface px-4 font-semibold text-ink no-underline hover:bg-subtle hover:text-ink" download>
              <Icon name="download" size={18} />
              Download CSV
            </a>
          </div>
        </Card>
      </div>
    </div>
  );
}
