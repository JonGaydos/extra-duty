import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { calendarEntries, detailCards, filterOptions, getFilterPrefs, type CalEntry, type DetailFilters, type FilterOptions } from "@/domain/calendar/calendar";
import { detailFormOptions } from "@/domain/coordinator/views";
import { editBlockReason } from "@/domain/jobs/bulk-edit";
import { parseDetailNumber, visibleJobIdByNumber } from "@/domain/jobs/detail-number";
import type { JobCard } from "@/domain/personnel/views";
import { listHiddenVendors } from "@/domain/planning/preferences";
import { Button, ButtonLink } from "@/ui/components/Button";
import { FormField, Input } from "@/ui/components/FormField";
import { Card } from "@/ui/components/Card";
import { Chip } from "@/ui/components/Chip";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { getCalendarFeedStatus } from "@/domain/planning/calendar";
import { getWorkSchedule } from "@/domain/planning/schedule";
import { SelectableDetails, type SelectableItem } from "../coordinate/_coordinator/SelectableDetails";
import { scheduleNoteFor } from "../_personnel/filters";
import { hoursText, plural, whenText } from "../_personnel/format";
import { HideVendorButton } from "../_personnel/HideVendorButton";
import { cardRow, DetailRowBody, RowList, type RowChip } from "../_personnel/JobRow";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { activeCount, filterParams, resolveFilters } from "../_shared/detail-filters";
import { FilterPanel } from "../_shared/FilterPanel";

export const metadata: Metadata = { title: "Details" };

type Params = Record<string, string | string[] | undefined>;
type Props = { searchParams: Promise<Params> };
const DAY_MS = 86_400_000;
/** How far ahead a deputy's list looks. */
const LIST_DAYS = 120;
/** How far ahead staff look (they post details up to two years out), and the most the schedule filter allows. */
const STAFF_DAYS = 730;
const WORKABLE_DAYS = 400;

/**
 * Staff choose which details: Upcoming (everyone's list, with the deputy filters) or the vendor requests, canceled
 * and past details only they see.
 */
const VIEWS = {
  upcoming: { label: "Upcoming" },
  requests: { label: "Requests", states: ["requested"] },
  canceled: { label: "Canceled", states: ["canceled", "declined"] },
  past: { label: "Past", states: ["scheduled", "active"] },
} as const;
type View = keyof typeof VIEWS;

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";

/** The empty list: none of the person's own, or none matching the filters. */
function NoDetails({ mine }: Readonly<{ mine: boolean }>) {
  if (mine) return <EmptyState title="You are not on any details">Details you sign up for show here.</EmptyState>;
  return <EmptyState title="No details match">Clear a filter or check back when new details are released.</EmptyState>;
}

/** Staff chips added to a card's own: the repeat series. */
function staffRow(c: JobCard, now: Date, extra?: React.ReactNode): SelectableItem {
  const row = cardRow(c, now);
  const chips: RowChip[] = c.seriesId ? [...row.chips, { tone: "neutral", text: "Series" }] : row.chips;
  return { ...row, chips, blocked: editBlockReason(c, now), extra };
}

const STATE: Record<string, RowChip> = {
  requested: { tone: "warning", text: "Vendor request" },
  declined: { tone: "neutral", text: "Declined" },
  canceled: { tone: "danger", text: "Canceled" },
};

/** A request, canceled or past detail (staff views), in the same row look. */
function entryRow(e: CalEntry, now: Date): SelectableItem {
  const open = e.needed - e.filled;
  const chips: RowChip[] = [STATE[e.state] ?? (open > 0 ? { tone: "attention", text: `${open} open` } : { tone: "neutral", text: "Filled" })];
  if (e.held) chips.push({ tone: "warning", text: "Held" });
  else if (e.status === "not_released") chips.push({ tone: "info", text: "Not released" });
  if (e.seriesId) chips.push({ tone: "neutral", text: "Series" });
  const where = e.locationName ? `, ${e.locationName}` : "";
  return {
    id: e.id,
    href: `/jobs/${e.number}`,
    heading: e.vendorName,
    sub: `#${e.number} ${e.title}`,
    when: `${whenText(e.startAt, e.endAt, now)}, ${hoursText(Math.round((e.endAt.getTime() - e.startAt.getTime()) / 60_000))}${where}`,
    pay: e.pay,
    chips,
    address: e.address,
    lat: e.lat,
    lng: e.lng,
    blocked: editBlockReason(e, now),
  };
}

type ListData = {
  items: SelectableItem[];
  /** The summary line before the list. */
  summary: string;
  filters: DetailFilters;
  options: FilterOptions;
  remember: boolean;
  empty: React.ReactNode;
};

type Actor = Awaited<ReturnType<typeof personnelActor>>;

/** Upcoming, everyone's list: job cards with the deputy filters, plus the viewer's own canceled sign-ups when "My details only". */
async function loadUpcoming(actor: Actor, staff: boolean, filters: DetailFilters, now: Date): Promise<Omit<ListData, "filters" | "remember">> {
  const workableCap = filters.workable ? WORKABLE_DAYS : STAFF_DAYS;
  const days = staff ? Math.min(STAFF_DAYS, workableCap) : LIST_DAYS;
  const range = { from: filters.mine ? new Date(now.getTime() - DAY_MS) : now, to: new Date(now.getTime() + days * DAY_MS), runningAt: now };
  const data = await withTx(async (tx) => ({
    ...(await detailCards(actor, tx, range, filters, now, { keepStarted: staff })),
    options: await filterOptions(actor, tx, range),
    hiddenVendors: (await listHiddenVendors(actor, tx, actor.userId)).length,
  }));
  // Staff Upcoming leaves vendor requests and canceled details to their own views.
  const cards = staff ? data.cards.filter((c) => c.state === "scheduled" || c.state === "active") : data.cards;
  const hide = (c: JobCard) =>
    c.mine ? undefined : (
      <span className="ml-auto">
        <HideVendorButton vendorId={c.vendorId} vendorName={c.vendorName} compact />
      </span>
    );
  const own = (c: JobCard): SelectableItem => (staff ? staffRow(c, now, hide(c)) : { ...cardRow(c, now), blocked: null, selectable: false, extra: hide(c) });
  const gone = data.gone.map(
    (d): SelectableItem => ({
      ...cardRow(d.job, now),
      key: d.assignmentId,
      blocked: null,
      selectable: false,
      extra: (
        <>
          <Chip tone="danger">{d.label}</Chip>
          <span className="text-sm text-muted">{d.reason}</span>
        </>
      ),
    }),
  );
  const filtered = activeCount(filters, true) > (filters.mine ? 1 : 0);
  const summary = [
    filters.mine ? `${plural(cards.length + data.gone.length, "detail")}, yours only` : plural(cards.length, "detail"),
    filtered ? "filtered" : null,
    data.hiddenBySchedule > 0 ? `${data.hiddenBySchedule} hidden by your schedule` : null,
    data.hiddenVendors > 0 ? `${plural(data.hiddenVendors, "vendor")} hidden` : null,
    data.truncated ? "showing the first 2,000; narrow the filters to see the rest" : null,
  ]
    .filter(Boolean)
    .join(", ");
  return { items: [...cards.map(own), ...gone], summary, options: data.options, empty: <NoDetails mine={filters.mine} /> };
}

/** Staff views over every detail: vendor requests and canceled (90 days back), or the past year, newest first. */
async function loadStaffView(actor: Actor, view: Exclude<View, "upcoming">, filters: DetailFilters, now: Date): Promise<Omit<ListData, "filters" | "remember">> {
  const states: readonly string[] = VIEWS[view].states;
  const from = view === "canceled" ? new Date(now.getTime() - 90 * DAY_MS) : now;
  const window = view === "past" ? { from: new Date(now.getTime() - 365 * DAY_MS), to: now } : { from, to: new Date(now.getTime() + STAFF_DAYS * DAY_MS), runningAt: now };
  const data = await withTx(async (tx) => ({ ...(await calendarEntries(actor, tx, window, filters, now)), options: await filterOptions(actor, tx, window) }));
  const list = data.entries.filter((e) => states.includes(e.state));
  const rows = view === "past" ? [...list].reverse() : list;
  const filtered = activeCount(filters, true) > (filters.mine ? 1 : 0);
  const summary = [plural(rows.length, "detail"), filtered ? "filtered" : null, data.truncated ? "only the first 2,000 are read; narrow the filters" : null].filter(Boolean).join(", ");
  const empty = <EmptyState title="No details here">{filtered ? "Nothing matches these filters." : "Details you post show up here."}</EmptyState>;
  return { items: rows.map((e) => entryRow(e, now)), summary, options: data.options, empty };
}

/** "Go to detail #": type a detail's number to open it. */
function GoToDetail({ value }: Readonly<{ value: string }>) {
  return (
    <form action="/jobs" role="search" aria-label="Go to a detail" className="flex items-end gap-2">
      <div className="w-36">
        <FormField label="Go to detail #">
          <Input name="go" defaultValue={value} inputMode="numeric" placeholder="9" maxLength={10} autoComplete="off" />
        </FormField>
      </div>
      <Button type="submit" variant="secondary">
        Go
      </Button>
    </form>
  );
}

/** The rows: with a checkbox each and Edit selected for staff, plain for everyone else. */
function DetailList({ list, edit }: Readonly<{ list: ListData; edit: Awaited<ReturnType<typeof detailFormOptions>> | null }>) {
  if (list.items.length === 0) return <Card pad={false}>{list.empty}</Card>;
  if (edit) return <SelectableDetails types={edit.positionTypes} defaultTypeId={edit.defaultPositionTypeId ?? edit.positionTypes[0]?.id ?? ""} items={list.items} />;
  return (
    <Card pad={false}>
      <RowList label="Details">
        {list.items.map((i) => (
          <li key={i.key ?? i.id}>
            <div className="flex px-4 py-3.25">
              <DetailRowBody row={i} extra={i.extra} />
            </div>
          </li>
        ))}
      </RowList>
    </Card>
  );
}

/**
 * Details, the same list for everyone: the shared filter panel and each detail's pay, times and status. Coordinators
 * and admins also get New detail, the Requests, Canceled and Past views, every status and person in the filters, the
 * detail number and Series chip on each row, and a checkbox per row for Edit selected.
 */
export default async function JobsPage({ searchParams }: Readonly<Props>) {
  const actor = await personnelActor();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const sp = await searchParams;
  const asked = one(sp.view);
  const view: View = staff && asked in VIEWS ? (asked as View) : "upcoming";
  const now = new Date();
  // Go to detail #: straight to the detail, or a plain "not one you can see" (never which).
  const go = one(sp.go).trim();
  const goNumber = go ? parseDetailNumber(go) : null;
  if (goNumber !== null && (await withTx((tx) => visibleJobIdByNumber(actor, tx, goNumber)))) redirect(`/jobs/${goNumber}`);
  const prefs = await withTx((tx) => getFilterPrefs(actor, tx));
  // One filter set for every view (List, Calendar and Map), the For you filters included.
  const filters = resolveFilters(sp, prefs, { personal: true });
  const loaded = view === "upcoming" ? await loadUpcoming(actor, staff, filters, now) : await loadStaffView(actor, view, filters, now);
  const list: ListData = { ...loaded, filters, remember: prefs.remember };
  const scheduleNote = await withTx(async (tx) => scheduleNoteFor(await getWorkSchedule(actor, tx, actor.userId), (await getCalendarFeedStatus(actor, tx, actor.userId)).connected));
  const edit = staff ? await withTx((tx) => detailFormOptions(actor, tx, now)) : null;
  const personal = view === "upcoming";
  const fq = filterParams(list.filters).toString();

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          <div className="flex flex-wrap items-center gap-2">
            <TabLinks
              label="Details views"
              current="list"
              items={[
                { key: "list", label: "List", href: `/jobs?${fq}` },
                { key: "calendar", label: "Calendar", href: `/calendar?${fq}` },
                { key: "map", label: "Map", href: `/map?${fq}` },
              ]}
            />
            {staff ? (
              <ButtonLink href="/jobs/new">
                <Icon name="plus" size={20} />
                New detail
              </ButtonLink>
            ) : null}
          </div>
        }
      >
        Details
      </PageTitle>
      <GoToDetail value={go} />
      {go ? <Notice tone="warning">{goNumber === null ? `"${go}" is not a detail number. Type the number, such as 9.` : `No detail #${goNumber} that you can see.`}</Notice> : null}
      {one(sp.filter_error) ? <Notice tone="danger">Your filters were applied but could not be saved. Try again.</Notice> : null}
      <div className="grid gap-4.5 md:grid-cols-[272px_minmax(0,1fr)] md:items-start md:gap-6">
        <FilterPanel
          path="/jobs"
          keep={staff && view !== "upcoming" ? { view } : {}}
          filters={list.filters}
          options={list.options}
          remember={list.remember}
          active={activeCount(list.filters, true)}
          staff={staff}
          scheduleNote={scheduleNote}
          sort={personal}
        />
        <div className="flex min-w-0 flex-col gap-2.5">
          {staff ? (
            <TabLinks
              label="Which details"
              current={view}
              items={Object.entries(VIEWS).map(([k, x]) => ({ key: k, label: x.label, href: k === "upcoming" ? `/jobs?${fq}` : `/jobs?view=${k}&${fq}` }))}
            />
          ) : null}
          <output className="m-0 block text-sm text-muted">{list.summary}.</output>
          <DetailList list={list} edit={edit} />
        </div>
      </div>
    </div>
  );
}

