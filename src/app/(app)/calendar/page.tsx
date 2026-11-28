import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { appUrl } from "@/domain/auth/invites";
import { calendarEntries, filterOptions, getFilterPrefs, listedDay, type CalEntry, type DetailRange } from "@/domain/calendar/calendar";
import { detailFormOptions } from "@/domain/coordinator/views";
import { editBlockReason } from "@/domain/jobs/bulk-edit";
import { calendarTokenStatus } from "@/domain/planning/ics-feed";
import { getSettings } from "@/domain/settings/settings";
import { getCalendarFeedStatus } from "@/domain/planning/calendar";
import { getWorkSchedule } from "@/domain/planning/schedule";
import { agencyDateOnly, agencyDateParts, agencyDayKey, agencyInstant } from "@/domain/time/agency-time";
import { Card, CardTitle } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { dateLabel, dayLabel, longDay, monthYear, plural, timeRange } from "../_personnel/format";
import { scheduleNoteFor } from "../_personnel/filters";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { activeCount, filterParams, resolveFilters } from "../_shared/detail-filters";
import { FilterPanel } from "../_shared/FilterPanel";
import { SelectableDetails, type SelectableItem } from "../coordinate/_coordinator/SelectableDetails";
import { CompactEntry, EntryRow, Legend, entryChips, entryHref, withPlace } from "./entries";
import { FeedCard } from "./FeedCard";

export const metadata: Metadata = { title: "Calendar" };

type View = "day" | "week" | "month" | "list";
const VIEWS: View[] = ["day", "week", "month", "list"];
type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

type Ymd = { y: number; m: number; d: number };
const ymd = (at: Date): Ymd => {
  const p = agencyDateParts(at);
  return { y: p.year, m: p.month, d: p.day };
};
const add = (a: Ymd, days: number, months = 0): Ymd => {
  const t = new Date(Date.UTC(a.y, a.m - 1 + months, a.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const key = (a: Ymd) => `${a.y}-${String(a.m).padStart(2, "0")}-${String(a.d).padStart(2, "0")}`;
const start = (a: Ymd) => agencyInstant(a.y, a.m, a.d, 0, 0);
const weekday = (a: Ymd) => new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();
const LIST_DAYS = 60;

function DayList({ days, byDay, empty, managed }: Readonly<{ days: Ymd[]; byDay: Map<string, CalEntry[]>; empty: string; managed: ReadonlySet<string> }>) {
  const shown = days.filter((day) => byDay.has(key(day)));
  if (shown.length === 0)
    return (
      <Card pad={false}>
        <EmptyState title={empty}>Change the filters or the dates to see more.</EmptyState>
      </Card>
    );
  return (
    <ol className="m-0 flex list-none flex-col gap-4 p-0">
      {shown.map((day) => {
        const list = byDay.get(key(day))!;
        return (
          <li key={key(day)} className="flex flex-col gap-2">
            <h2 className="m-0 text-sm font-semibold text-muted">
              {longDay(start(day))}, {plural(list.length, "detail")}
            </h2>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {list.map((e) => (
                <li key={e.id}>
                  <EntryRow e={e} manage={managed.has(e.vendorId)} />
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

type Href = (v: View, date?: Ymd) => string;
type Filters = ReturnType<typeof resolveFilters>;
type DetailOptions = Awaited<ReturnType<typeof detailFormOptions>>;

/** The days a view shows: the focus day, its week, its month in whole weeks, or the next 60 days from today. */
function viewDays(view: View, focus: Ymd, weekStartsOn: number, now: Date): Ymd[] {
  if (view === "day") return [focus];
  if (view === "week") {
    const from = add(focus, -((weekday(focus) - weekStartsOn + 7) % 7));
    return Array.from({ length: 7 }, (_, i) => add(from, i));
  }
  if (view === "month") {
    const first = { ...focus, d: 1 };
    const from = add(first, -((weekday(first) - weekStartsOn + 7) % 7));
    const span = Math.round((start(add(first, 0, 1)).getTime() - start(from).getTime()) / 86_400_000);
    return Array.from({ length: Math.ceil(span / 7) * 7 }, (_, i) => add(from, i));
  }
  return Array.from({ length: LIST_DAYS }, (_, i) => add(ymd(now), i));
}

/** The view's dates. The list and today's day view also show a detail that started earlier and is still running, under today. */
function viewRange(view: View, days: Ymd[], today: string, now: Date): DetailRange {
  const running = view === "list" || (view === "day" && key(days[0]) === today);
  return { from: start(days[0]), to: start(add(days.at(-1)!, 1)), ...(running ? { runningAt: now } : {}) };
}

/** How far Previous and Next move. */
const STEP: Record<View, { d: number; m: number }> = { day: { d: 1, m: 0 }, week: { d: 7, m: 0 }, month: { d: 0, m: 1 }, list: { d: 0, m: 1 } };

const EMPTY_TITLE: Record<View, string> = { day: "No details this day", week: "No details this week", month: "No details in the next 60 days", list: "No details in the next 60 days" };

function viewTitle(view: View, focus: Ymd, days: Ymd[]): string {
  if (view === "day") return longDay(start(focus));
  if (view === "week") return `Week of ${dayLabel(start(days[0]))}`;
  if (view === "month") return monthYear(start(focus));
  return "Next 60 days";
}

const dateParam = (date?: Ymd) => (date ? `&date=${key(date)}` : "");

/** The desktop day number: filled for today, muted outside the month. */
function dayNumberClass(isToday: boolean, inMonth: boolean): string {
  if (isToday) return "bg-accent font-bold text-on-accent hover:text-on-accent";
  return `font-medium hover:bg-subtle ${inMonth ? "text-ink" : "text-muted"}`;
}

/** One day of the month grid: on phones the day and its count, on desktop a count and the day's entries. */
function MonthDay({ day, list, inMonth, isToday, href }: Readonly<{ day: Ymd; list: CalEntry[]; inMonth: boolean; isToday: boolean; href: Href }>) {
  const dayName = `${longDay(start(day))}${isToday ? ", today" : ""}`;
  return (
    <td className={`h-16 border-l border-divider p-1 align-top first:border-l-0 md:h-36 ${isToday ? "bg-accent-soft" : ""}`} aria-current={isToday ? "date" : undefined}>
      {/* Phones: the day and its count; the day opens its list. */}
      <Link
        href={href("day", day)}
        data-button-link
        className={`flex h-full flex-col items-center gap-1 rounded-xs p-0.5 text-ink no-underline hover:bg-subtle hover:text-ink md:hidden ${inMonth ? "" : "text-muted"}`}
      >
        <span className="sr-only">
          {dayName}, {plural(list.length, "detail")}
        </span>
        <span aria-hidden className={`flex size-6 items-center justify-center rounded-full text-xs ${isToday ? "bg-accent font-bold text-on-accent" : "font-medium"}`} data-numeric>
          {day.d}
        </span>
        {list.length ? (
          <span aria-hidden className="rounded-full bg-sunken px-1.5 text-micro font-semibold" data-numeric>
            {list.length}
          </span>
        ) : null}
      </Link>
      {/* Desktop: a count and a scrolling list of "7:00 AM Vendor" entries. */}
      <div className="hidden h-full flex-col gap-0.5 md:flex">
        <div className="flex items-center justify-between gap-1">
          <Link href={href("day", day)} data-button-link className={`flex size-6 items-center justify-center rounded-full text-xs no-underline ${dayNumberClass(isToday, inMonth)}`} data-numeric>
            <span aria-hidden>{day.d}</span>
            <span className="sr-only">{dayName}, open the day</span>
          </Link>
          {list.length ? (
            <span className="text-micro font-medium text-muted" data-numeric>
              {plural(list.length, "detail")}
            </span>
          ) : null}
        </div>
        {list.length ? (
          <ul className="m-0 flex max-h-28 list-none flex-col overflow-y-auto p-0" aria-label={`${dayName} details`}>
            {list.map((e) => (
              <li key={e.id}>
                <CompactEntry e={e} />
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </td>
  );
}

/** The month as a table of weeks, then the legend. */
function MonthGrid({ title, days, byDay, focus, today, staff, href }: Readonly<{ title: string; days: Ymd[]; byDay: Map<string, CalEntry[]>; focus: Ymd; today: string; staff: boolean; href: Href }>) {
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(d.y, d.m - 1, d.d))));
  return (
    <>
      <Card pad={false} className="overflow-hidden">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">{title}: details by day</caption>
          <thead>
            <tr>
              {weekdays.map((w) => (
                <th key={w} scope="col" className="py-2 text-xs font-semibold text-muted">
                  {w}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {Array.from({ length: days.length / 7 }, (_, r) => (
              <tr key={r} className="border-t border-divider">
                {days.slice(r * 7, r * 7 + 7).map((day) => (
                  <MonthDay key={key(day)} day={day} list={byDay.get(key(day)) ?? []} inMonth={day.m === focus.m} isToday={key(day) === today} href={href} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      <Legend staff={staff} />
      <p className="m-0 text-xs text-muted md:hidden">Tap a day to see its details.</p>
    </>
  );
}

/** Staff's list view: the details with checkboxes for bulk edit. */
function StaffList({ entries, edit, now }: Readonly<{ entries: CalEntry[]; edit: DetailOptions; now: Date }>) {
  if (entries.length === 0)
    return (
      <Card pad={false}>
        <EmptyState title="No details in the next 60 days">Change the filters to see more.</EmptyState>
      </Card>
    );
  return (
    <SelectableDetails
      types={edit.positionTypes}
      defaultTypeId={edit.defaultPositionTypeId ?? edit.positionTypes[0]?.id ?? ""}
      items={entries.map(
        (e): SelectableItem => ({
          id: e.id,
          href: entryHref(e),
          heading: e.vendorName,
          sub: `#${e.number} ${e.title}`,
          when: withPlace(`${dayLabel(e.startAt)}, ${timeRange(e.startAt, e.endAt)}`, e.locationName),
          pay: e.pay,
          address: e.address,
          lat: e.lat,
          lng: e.lng,
          chips: entryChips(e),
          blocked: editBlockReason(e, now),
        }),
      )}
    />
  );
}

/** "12 details, yours only, filtered." */
function CountLine({ count, filters, truncated }: Readonly<{ count: number; filters: Filters; truncated: boolean }>) {
  const mineFilters = filters.mine ? 1 : 0;
  return (
    <output className="block m-0 text-sm text-muted">
      {plural(count, "detail")}
      {filters.mine ? ", yours only" : ""}
      {activeCount(filters, true) > mineFilters ? ", filtered" : ""}
      {truncated ? ". Only the first 2,000 are shown; narrow the filters." : "."}
    </output>
  );
}

/**
 * Every detail the person may see by day, week, month or as a list, with the shared filter panel (My details only,
 * status, vendor, type, place, person, job number, search). Staff also see vendor requests and can bulk edit from
 * the list. Personnel keep their personal calendar link.
 */
export default async function CalendarPage({ searchParams }: Readonly<Props>) {
  const actor = await personnelActor();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  // A vendor manager gets Manage on their vendors' details (owner decision 2026-11-27); staff manage from the detail.
  const managed: ReadonlySet<string> = new Set(staff ? [] : (actor.managedVendorIds ?? []));
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const view: View = VIEWS.includes(one(sp.view) as View) ? (one(sp.view) as View) : "month";
  const now = new Date();
  const picked = agencyDateOnly(one(sp.date));
  const focus = ymd(picked ?? now);

  const base = await withTx(async (tx) => ({ settings: await getSettings(tx), prefs: await getFilterPrefs(actor, tx) }));
  // One filter set for every view (List, Calendar and Map), the For you filters included.
  const filters = resolveFilters(sp, base.prefs, { personal: true });
  const days = viewDays(view, focus, base.settings.weekStartsOn, now);
  const today = agencyDayKey(now);
  const range = viewRange(view, days, today, now);

  const data = await withTx(async (tx) => ({
    ...(await calendarEntries(actor, tx, range, filters, now)),
    options: await filterOptions(actor, tx, range),
    feed: await calendarTokenStatus(actor, tx),
    edit: staff && view === "list" ? await detailFormOptions(actor, tx, now) : null,
    note: scheduleNoteFor(await getWorkSchedule(actor, tx, actor.userId), (await getCalendarFeedStatus(actor, tx, actor.userId)).connected),
  }));
  const byDay = new Map<string, CalEntry[]>();
  for (const e of data.entries) {
    const k = listedDay(e.startAt, range.from);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }

  // The configured app URL, never a request header, so a spoofed Host cannot change the link a person copies.
  const origin = appUrl();
  const step = STEP[view];
  const prev = add(focus, -step.d, -step.m);
  const next = add(focus, step.d, step.m);
  const title = viewTitle(view, focus, days);
  const fq = filterParams(filters).toString();
  const href: Href = (v, date) => `/calendar?view=${v}${dateParam(date)}&${fq}`;
  const keep: Record<string, string> = { view, ...(view === "list" ? {} : { date: key(focus) }) };
  let body: React.ReactNode;
  if (view === "month") body = <MonthGrid title={title} days={days} byDay={byDay} focus={focus} today={today} staff={staff} href={href} />;
  else if (view === "list" && staff && data.edit) body = <StaffList entries={data.entries} edit={data.edit} now={now} />;
  else
    body = (
      <>
        <DayList days={days} byDay={byDay} empty={EMPTY_TITLE[view]} managed={managed} />
        <Legend staff={staff} />
      </>
    );

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          <TabLinks
            label="Details views"
            current="calendar"
            items={[
              { key: "list", label: "List", href: `/jobs?${fq}` },
              { key: "calendar", label: "Calendar", href: `/calendar?${fq}` },
              { key: "map", label: "Map", href: `/map?${fq}` },
            ]}
          />
        }
      >
        Calendar
      </PageTitle>
      {one(sp.filter_error) ? <Notice tone="danger">Your filters were applied but could not be saved. Try again.</Notice> : null}

      <div className="grid gap-4.5 md:grid-cols-[272px_minmax(0,1fr)] md:items-start md:gap-6">
        <FilterPanel path="/calendar" keep={keep} filters={filters} options={data.options} remember={base.prefs.remember} active={activeCount(filters, true)} staff={staff} scheduleNote={data.note} />

        <div className="flex min-w-0 flex-col gap-3">
          <TabLinks label="Calendar range" current={view} items={VIEWS.map((v) => ({ key: v, label: v[0].toUpperCase() + v.slice(1), href: href(v, v === "list" ? undefined : focus) }))} />
          {view !== "list" ? (
            <div className="flex items-center justify-between gap-2">
              <Link href={href(view, prev)} aria-label="Previous" data-button-link className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink">
                <Icon name="chevronLeft" size={20} />
              </Link>
              <h2 className="m-0 text-title font-semibold md:text-base">{title}</h2>
              <Link href={href(view, next)} aria-label="Next" data-button-link className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink">
                <Icon name="chevronRight" size={20} />
              </Link>
            </div>
          ) : null}
          <CountLine count={data.entries.length} filters={filters} truncated={data.truncated} />

          {body}

          {data.feed ? (
            <Card>
              <CardTitle>Calendar link</CardTitle>
              <FeedCard
                origin={origin}
                active={data.feed.active}
                since={data.feed.createdAt ? dateLabel(data.feed.createdAt) : null}
                lastUsed={data.feed.lastUsedAt ? dateLabel(data.feed.lastUsedAt) : null}
              />
            </Card>
          ) : null}
        </div>
      </div>
    </div>
  );
}
