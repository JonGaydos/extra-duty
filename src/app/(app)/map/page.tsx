import type { Metadata } from "next";
import { withTx } from "@/ui/shell/request";
import { detailCards, filterOptions, getFilterPrefs } from "@/domain/calendar/calendar";
import { getCalendarFeedStatus } from "@/domain/planning/calendar";
import { getWorkSchedule } from "@/domain/planning/schedule";
import { getSettings } from "@/domain/settings/settings";
import { Card, CardTitle } from "@/ui/components/Card";
import { Notice } from "@/ui/components/Notice";
import { detailTitle } from "@/domain/jobs/detail-name";
import { scheduleNoteFor } from "../_personnel/filters";
import { plural, whenText } from "../_personnel/format";
import { JobRow, RowList } from "../_personnel/JobRow";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { activeCount, filterParams, resolveFilters } from "../_shared/detail-filters";
import { FilterPanel } from "../_shared/FilterPanel";
import { MapView, type MapJob } from "./MapView";

export const metadata: Metadata = { title: "Map" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };
const DAY_MS = 86_400_000;
/** How far ahead the map looks: the Details list's own window (staff: two years; the schedule filter: 400 days at most). */
const LIST_DAYS = 120;
const STAFF_DAYS = 730;
const WORKABLE_DAYS = 400;

/** Details on a map, with the same filter panel and the same filters as the List and the Calendar. */
export default async function MapPage({ searchParams }: Readonly<Props>) {
  const actor = await personnelActor();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const sp = await searchParams;
  const now = new Date();
  const prefs = await withTx((tx) => getFilterPrefs(actor, tx));
  const filters = resolveFilters(sp, prefs, { personal: true });
  const staffDays = filters.workable ? WORKABLE_DAYS : STAFF_DAYS;
  const days = staff ? staffDays : LIST_DAYS;
  const range = { from: filters.mine ? new Date(now.getTime() - DAY_MS) : now, to: new Date(now.getTime() + days * DAY_MS), runningAt: now };
  const data = await withTx(async (tx) => {
    const list = await detailCards(actor, tx, range, filters, now, { keepStarted: staff });
    const settings = await getSettings(tx);
    const options = await filterOptions(actor, tx, range);
    const note = scheduleNoteFor(await getWorkSchedule(actor, tx, actor.userId), (await getCalendarFeedStatus(actor, tx, actor.userId)).connected);
    // Staff see on the map what their Upcoming list shows: vendor requests and canceled details have their own views.
    const cards = staff ? list.cards.filter((c) => c.state === "scheduled" || c.state === "active") : list.cards;
    return { ...list, cards, settings, options, note };
  });
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const placed = data.cards.filter((c) => c.lat !== null && c.lng !== null);
  const unplaced = data.cards.filter((c) => c.lat === null || c.lng === null);
  const jobs: MapJob[] = placed.map((c) => ({
    id: c.id,
    number: c.number,
    vendorName: c.vendorName,
    title: detailTitle(c),
    when: whenText(c.startAt, c.endAt, now),
    where: [c.locationName, c.address].filter(Boolean).join(", "),
    address: c.address,
    lat: c.lat!,
    lng: c.lng!,
    totalCents: c.totalCents,
    rateCents: c.rateCents,
    upTo: { totalCents: c.maxTotalCents, rateCents: c.maxRateCents },
    safety: c.hasSafety,
    held: c.held,
  }));
  const fq = filterParams(filters).toString();

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          <TabLinks
            label="Details views"
            current="map"
            items={[
              { key: "list", label: "List", href: `/jobs?${fq}` },
              { key: "calendar", label: "Calendar", href: `/calendar?${fq}` },
              { key: "map", label: "Map", href: `/map?${fq}` },
            ]}
          />
        }
      >
        Map
      </PageTitle>
      {one(sp.filter_error) ? <Notice tone="danger">Your filters were applied but could not be saved. Try again.</Notice> : null}
      <div className="grid gap-4.5 md:grid-cols-[272px_minmax(0,1fr)] md:items-start md:gap-6">
        <FilterPanel path="/map" keep={{}} filters={filters} options={data.options} remember={prefs.remember} active={activeCount(filters, true)} staff={staff} scheduleNote={data.note} />
        <div className="flex min-w-0 flex-col gap-4.5">
          <MapView jobs={jobs} tileUrl={data.settings.mapTileUrl} attribution={data.settings.mapAttribution} center={data.settings.mapDefaultCenter} />
          <Card pad={false}>
            <div className="px-4 pt-4">
              <CardTitle>On the map</CardTitle>
              <p className="m-0 mt-1 text-sm text-muted">
                {plural(placed.length, "detail")}
                {unplaced.length ? `. ${plural(unplaced.length, "detail")} without a map location listed below.` : "."}
                {data.hiddenBySchedule ? ` ${data.hiddenBySchedule} hidden by your schedule.` : ""}
              </p>
            </div>
            <RowList label="Details on the map">
              {[...placed, ...unplaced].map((c) => (
                <li key={c.id}>
                  <JobRow card={c} now={now} />
                </li>
              ))}
            </RowList>
          </Card>
        </div>
      </div>
    </div>
  );
}
