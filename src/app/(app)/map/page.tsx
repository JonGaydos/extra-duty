import type { Metadata } from "next";
import { asc, eq } from "drizzle-orm";
import { withTx } from "@/ui/shell/request";
import { jobTypes } from "@/db/schema";
import { getCalendarFeedStatus } from "@/domain/planning/calendar";
import { getWorkSchedule } from "@/domain/planning/schedule";
import { getSettings } from "@/domain/settings/settings";
import { Card, CardTitle } from "@/ui/components/Card";
import { filteredJobs, filterQuery, parseFilters, scheduleNoteFor } from "../_personnel/filters";
import { plural, whenText } from "../_personnel/format";
import { JobFilters } from "../_personnel/JobFilters";
import { JobRow, RowList } from "../_personnel/JobRow";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { MapView, type MapJob } from "./MapView";

export const metadata: Metadata = { title: "Map" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

/** Details on a map with the same filters as the list ("Only details I can work" included). */
export default async function MapPage({ searchParams }: Props) {
  const actor = await personnelActor();
  const f = parseFilters(await searchParams);
  const now = new Date();
  const data = await withTx(async (tx) => {
    const list = await filteredJobs(actor, tx, f, now);
    const settings = await getSettings(tx);
    const types = await tx.select({ id: jobTypes.id, name: jobTypes.name }).from(jobTypes).where(eq(jobTypes.active, true)).orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name));
    const note = scheduleNoteFor(await getWorkSchedule(actor, tx, actor.userId), (await getCalendarFeedStatus(actor, tx, actor.userId)).connected);
    return { ...list, settings, types, note };
  });
  const placed = data.cards.filter((c) => c.lat !== null && c.lng !== null);
  const unplaced = data.cards.filter((c) => c.lat === null || c.lng === null);
  const jobs: MapJob[] = placed.map((c) => ({
    id: c.id,
    vendorName: c.vendorName,
    title: c.title,
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
  const query = filterQuery(f);

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          <TabLinks
            label="Details views"
            current="map"
            items={[
              { key: "list", label: "List", href: `/jobs${query}` },
              { key: "calendar", label: "Calendar", href: "/calendar" },
              { key: "map", label: "Map", href: `/map${query}` },
            ]}
          />
        }
      >
        Map
      </PageTitle>
      <div className="grid gap-4.5 md:grid-cols-[320px_minmax(0,1fr)] md:items-start md:gap-6">
        <JobFilters types={data.types} scheduleNote={data.note} showSort={false} />
        <div className="flex flex-col gap-4.5">
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
