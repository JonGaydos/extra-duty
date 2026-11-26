import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { detailCards, filterOptions, getFilterPrefs } from "@/domain/calendar/calendar";
import { listHiddenVendors } from "@/domain/planning/preferences";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { getCalendarFeedStatus } from "@/domain/planning/calendar";
import { getWorkSchedule } from "@/domain/planning/schedule";
import { scheduleNoteFor } from "../_personnel/filters";
import { plural } from "../_personnel/format";
import { HideVendorButton } from "../_personnel/HideVendorButton";
import { JobRow, RowList } from "../_personnel/JobRow";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { activeCount, resolveFilters } from "../_shared/detail-filters";
import { FilterPanel } from "../_shared/FilterPanel";

export const metadata: Metadata = { title: "Details" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const DAY_MS = 86_400_000;

/** The empty list: none of the person's own, or none matching the filters. */
function NoDetails({ mine }: Readonly<{ mine: boolean }>) {
  if (mine) return <EmptyState title="You are not on any details">Details you sign up for show here.</EmptyState>;
  return <EmptyState title="No details match">Clear a filter or check back when new details are released.</EmptyState>;
}
/** How far ahead the list looks. */
const LIST_DAYS = 120;

/**
 * The deputy's detail list with the shared per-person filter panel (the Calendar's): status, vendor, vendor type,
 * detail type, location, a person on a roster they can see, job number, search, My details only, Remember.
 */
export default async function JobsPage({ searchParams }: Readonly<Props>) {
  const actor = await personnelActor();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const sp = await searchParams;
  const now = new Date();
  const prefs = await withTx((tx) => getFilterPrefs(actor, tx));
  const filters = resolveFilters(sp, prefs, { personal: true });
  const range = { from: filters.mine ? new Date(now.getTime() - DAY_MS) : now, to: new Date(now.getTime() + LIST_DAYS * DAY_MS), runningAt: now };
  const data = await withTx(async (tx) => ({
    ...(await detailCards(actor, tx, range, filters, now)),
    options: await filterOptions(actor, tx, range),
    hiddenVendors: (await listHiddenVendors(actor, tx, actor.userId)).length,
    note: scheduleNoteFor(await getWorkSchedule(actor, tx, actor.userId), (await getCalendarFeedStatus(actor, tx, actor.userId)).connected),
  }));
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const mineFilters = filters.mine ? 1 : 0;
  const summary = [
    filters.mine ? `${plural(data.cards.length + data.gone.length, "detail")}, yours only` : plural(data.cards.length, "detail"),
    activeCount(filters, true) > mineFilters ? "filtered" : null,
    data.hiddenBySchedule > 0 ? `${data.hiddenBySchedule} hidden by your schedule` : null,
    data.hiddenVendors > 0 ? `${plural(data.hiddenVendors, "vendor")} hidden` : null,
    data.truncated ? "showing the first 2,000; narrow the filters to see the rest" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          <TabLinks
            label="Details views"
            current="list"
            items={[
              { key: "list", label: "List", href: "/jobs" },
              { key: "calendar", label: "Calendar", href: "/calendar" },
              { key: "map", label: "Map", href: "/map" },
            ]}
          />
        }
      >
        Details
      </PageTitle>
      {one(sp.filter_error) ? <Notice tone="danger">Your filters were applied but could not be saved. Try again.</Notice> : null}
      <div className="grid gap-4.5 md:grid-cols-[272px_minmax(0,1fr)] md:items-start md:gap-6">
        <FilterPanel path="/jobs" keep={{}} filters={filters} options={data.options} remember={prefs.remember} active={activeCount(filters, true)} staff={staff} personal={{ scheduleNote: data.note }} />
        <div className="flex min-w-0 flex-col gap-2.5">
          <output className="block m-0 text-sm text-muted">
            {summary}.
          </output>
          <Card pad={false}>
            {data.cards.length === 0 && data.gone.length === 0 ? (
              <NoDetails mine={filters.mine} />
            ) : (
              <RowList label="Details">
                {data.cards.map((c) => (
                  <li key={c.id}>
                    <JobRow card={c} now={now} extra={c.mine ? undefined : <span className="ml-auto"><HideVendorButton vendorId={c.vendorId} vendorName={c.vendorName} compact /></span>} />
                  </li>
                ))}
                {data.gone.map((d) => (
                  <li key={d.assignmentId}>
                    <JobRow
                      card={d.job}
                      now={now}
                      extra={
                        <>
                          <Chip tone="danger">{d.label}</Chip>
                          <span className="text-sm text-muted">{d.reason}</span>
                        </>
                      }
                    />
                  </li>
                ))}
              </RowList>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
