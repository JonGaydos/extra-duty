import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { calendarEntries, filterOptions, getFilterPrefs } from "@/domain/calendar/calendar";
import { detailFormOptions } from "@/domain/coordinator/views";
import { editBlockReason } from "@/domain/jobs/bulk-edit";
import { ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { PageTitle, TabLinks } from "../../_personnel/TabLinks";
import { plural, prefixed, whenText } from "../../_personnel/format";
import { activeCount, filterParams, resolveFilters } from "../../_shared/detail-filters";
import { FilterPanel } from "../../_shared/FilterPanel";
import { coordinatorActor } from "../_coordinator/session";
import { SelectableDetails, type SelectableItem } from "../_coordinator/SelectableDetails";

export const metadata: Metadata = { title: "Details" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const DAY = 86_400_000;

const VIEWS = {
  upcoming: { label: "Upcoming", states: ["scheduled", "active"] as const, past: false },
  requests: { label: "Requests", states: ["requested"] as const, past: false },
  canceled: { label: "Canceled", states: ["canceled", "declined"] as const, past: false },
  past: { label: "Past", states: ["scheduled", "active"] as const, past: true },
};
type View = keyof typeof VIEWS;

const STATE: Record<string, { tone: "success" | "warning" | "danger" | "neutral" | "info"; text: string }> = {
  requested: { tone: "warning", text: "Vendor request" },
  declined: { tone: "neutral", text: "Declined" },
  canceled: { tone: "danger", text: "Canceled" },
};

/** Every detail a coordinator manages: upcoming, vendor requests, canceled and past, with the shared filters and bulk edit. */
export default async function DetailsPage({ searchParams }: Readonly<Props>) {
  const actor = await coordinatorActor();
  const sp = await searchParams;
  const view: View = typeof sp.view === "string" && sp.view in VIEWS ? (sp.view as View) : "upcoming";
  const now = new Date();
  const v = VIEWS[view];
  // Upcoming also lists a detail that started earlier and is still running, until it ends.
  const window = v.past ? { from: new Date(now.getTime() - 365 * DAY), to: now } : { from: view === "canceled" ? new Date(now.getTime() - 90 * DAY) : now, to: new Date(now.getTime() + 730 * DAY), runningAt: now };
  const prefs = await withTx((tx) => getFilterPrefs(actor, tx));
  const filters = resolveFilters(sp, prefs, { personal: false });
  const data = await withTx(async (tx) => ({
    ...(await calendarEntries(actor, tx, window, filters, now)),
    options: await filterOptions(actor, tx, window),
    edit: await detailFormOptions(actor, tx, now),
  }));
  const states: readonly string[] = v.states;
  const list = data.entries.filter((e) => states.includes(e.state));
  const rows = v.past ? [...list].reverse() : list;
  const fq = filterParams(filters).toString();
  const href = (k: string) => `/coordinate/details?view=${k}&${fq}`;
  const one = (x: string | string[] | undefined) => (Array.isArray(x) ? x[0] : x) ?? "";

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          <ButtonLink href="/coordinate/details/new">
            <Icon name="plus" size={20} />
            New detail
          </ButtonLink>
        }
      >
        Details
      </PageTitle>
      {one(sp.filter_error) ? <Notice tone="danger">Your filters were applied but could not be saved. Try again.</Notice> : null}
      <div className="grid gap-4.5 md:grid-cols-[272px_minmax(0,1fr)] md:items-start md:gap-6">
        <FilterPanel path="/coordinate/details" keep={{ view }} filters={filters} options={data.options} remember={prefs.remember} active={activeCount(filters, false)} staff />
        <div className="flex min-w-0 flex-col gap-3">
          <TabLinks label="Which details" current={view} items={Object.entries(VIEWS).map(([k, x]) => ({ key: k, label: x.label, href: href(k) }))} />
          <output className="block m-0 text-sm text-muted">
            {plural(rows.length, "detail")}
            {activeCount(filters, false) ? ", filtered" : ""}
            {data.truncated ? ". Only the first 2,000 are read; narrow the filters." : "."}
          </output>
          {rows.length === 0 ? (
            <Card pad={false}>
              <EmptyState title="No details here">{activeCount(filters, false) ? "Nothing matches these filters." : "Details you post show up here."}</EmptyState>
            </Card>
          ) : (
            <SelectableDetails
              types={data.edit.positionTypes}
              defaultTypeId={data.edit.defaultPositionTypeId ?? data.edit.positionTypes[0]?.id ?? ""}
              items={rows.map((j): SelectableItem => {
                const open = j.needed - j.filled;
                const chips: SelectableItem["chips"] = [];
                if (STATE[j.state]) chips.push({ tone: STATE[j.state].tone, text: STATE[j.state].text });
                else chips.push(open > 0 ? { tone: "attention", text: `${open} open` } : { tone: "neutral", text: "Filled" });
                if (j.held) chips.push({ tone: "warning", text: "Held" });
                else if (j.status === "not_released") chips.push({ tone: "info", text: "Not released" });
                if (j.seriesId) chips.push({ tone: "neutral", text: "Series" });
                return {
                  id: j.id,
                  href: `/coordinate/details/${j.id}`,
                  title: `#${j.number} ${j.title}`,
                  meta: `${j.vendorName}${prefixed(", ", j.locationName)}. ${whenText(j.startAt, j.endAt, now)}`,
                  pay: j.pay,
                  chips,
                  blocked: editBlockReason(j, now),
                };
              })}
            />
          )}
        </div>
      </div>
    </div>
  );
}
