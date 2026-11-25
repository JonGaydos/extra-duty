import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { appUrl } from "@/domain/auth/invites";
import { calendarEntries, filterOptions, getFilterPrefs, type CalEntry } from "@/domain/calendar/calendar";
import { detailFormOptions } from "@/domain/coordinator/views";
import { editBlockReason } from "@/domain/jobs/bulk-edit";
import { calendarTokenStatus } from "@/domain/planning/ics-feed";
import { getSettings } from "@/domain/settings/settings";
import { agencyDateOnly, agencyDateParts, agencyDayKey, agencyInstant } from "@/domain/time/agency-time";
import { Card, CardTitle } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { Notice } from "@/ui/components/Notice";
import { Icon } from "@/ui/icons";
import { dateLabel, dayLabel, longDay, monthYear, plural } from "../_personnel/format";
import { personnelActor } from "../_personnel/session";
import { PageTitle, TabLinks } from "../_personnel/TabLinks";
import { activeCount, filterParams, resolveFilters } from "../_shared/detail-filters";
import { FilterPanel } from "../_shared/FilterPanel";
import { SelectableDetails, type SelectableItem } from "../coordinate/_coordinator/SelectableDetails";
import { CompactEntry, EntryRow, Legend, entryHref } from "./entries";
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

function DayList({ days, byDay, staff, empty }: { days: Ymd[]; byDay: Map<string, CalEntry[]>; staff: boolean; empty: string }) {
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
                  <EntryRow e={e} staff={staff} />
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Every detail the person may see by day, week, month or as a list, with the shared filter panel (My details only,
 * status, vendor, type, place, person, job number, search). Staff also see vendor requests and can bulk edit from
 * the list. Personnel keep their personal calendar link.
 */
export default async function CalendarPage({ searchParams }: Props) {
  const actor = await personnelActor();
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const view: View = VIEWS.includes(one(sp.view) as View) ? (one(sp.view) as View) : "month";
  const now = new Date();
  const picked = agencyDateOnly(one(sp.date));
  const focus = ymd(picked ?? now);

  const base = await withTx(async (tx) => ({ settings: await getSettings(tx), prefs: await getFilterPrefs(actor, tx) }));
  const filters = resolveFilters(sp, base.prefs, { personal: false });
  let days: Ymd[];
  if (view === "day") {
    days = [focus];
  } else if (view === "week") {
    const from = add(focus, -((weekday(focus) - base.settings.weekStartsOn + 7) % 7));
    days = Array.from({ length: 7 }, (_, i) => add(from, i));
  } else if (view === "month") {
    const first = { ...focus, d: 1 };
    const from = add(first, -((weekday(first) - base.settings.weekStartsOn + 7) % 7));
    const span = Math.round((start(add(first, 0, 1)).getTime() - start(from).getTime()) / 86_400_000);
    days = Array.from({ length: Math.ceil(span / 7) * 7 }, (_, i) => add(from, i));
  } else {
    days = Array.from({ length: LIST_DAYS }, (_, i) => add(ymd(now), i));
  }
  const range = { from: start(days[0]), to: start(add(days[days.length - 1], 1)) };

  const data = await withTx(async (tx) => ({
    ...(await calendarEntries(actor, tx, range, filters, now)),
    options: await filterOptions(actor, tx, range),
    feed: await calendarTokenStatus(actor, tx),
    edit: staff && view === "list" ? await detailFormOptions(actor, tx, now) : null,
  }));
  const byDay = new Map<string, CalEntry[]>();
  for (const e of data.entries) {
    const k = agencyDayKey(e.startAt);
    byDay.set(k, [...(byDay.get(k) ?? []), e]);
  }

  // The configured app URL, never a request header, so a spoofed Host cannot change the link a person copies.
  const origin = appUrl();
  const step = view === "day" ? { d: 1, m: 0 } : view === "week" ? { d: 7, m: 0 } : { d: 0, m: 1 };
  const prev = add(focus, -step.d, -step.m);
  const next = add(focus, step.d, step.m);
  const title = view === "day" ? longDay(start(focus)) : view === "week" ? `Week of ${dayLabel(start(days[0]))}` : view === "month" ? monthYear(start(focus)) : "Next 60 days";
  const fq = filterParams(filters).toString();
  const href = (v: View, date?: Ymd) => `/calendar?view=${v}${date ? `&date=${key(date)}` : ""}&${fq}`;
  const today = agencyDayKey(now);
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(d.y, d.m - 1, d.d))));
  const keep: Record<string, string> = { view, ...(view === "list" ? {} : { date: key(focus) }) };

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle
        action={
          staff ? undefined : (
            <TabLinks
              label="Details views"
              current="calendar"
              items={[
                { key: "list", label: "List", href: "/jobs" },
                { key: "calendar", label: "Calendar", href: "/calendar" },
                { key: "map", label: "Map", href: "/map" },
              ]}
            />
          )
        }
      >
        Calendar
      </PageTitle>
      {one(sp.filter_error) ? <Notice tone="danger">Your filters were applied but could not be saved. Try again.</Notice> : null}

      <div className="grid gap-4.5 md:grid-cols-[272px_minmax(0,1fr)] md:items-start md:gap-6">
        <FilterPanel path="/calendar" keep={keep} filters={filters} options={data.options} remember={base.prefs.remember} active={activeCount(filters, false)} staff={staff} />

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
          <p className="m-0 text-sm text-muted" role="status">
            {plural(data.entries.length, "detail")}
            {filters.mine ? ", yours only" : ""}
            {activeCount(filters, false) > (filters.mine ? 1 : 0) ? ", filtered" : ""}
            {data.truncated ? ". Only the first 2,000 are shown; narrow the filters." : "."}
          </p>

          {view === "month" ? (
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
                        {days.slice(r * 7, r * 7 + 7).map((day) => {
                          const list = byDay.get(key(day)) ?? [];
                          const inMonth = day.m === focus.m;
                          const isToday = key(day) === today;
                          const dayName = `${longDay(start(day))}${isToday ? ", today" : ""}`;
                          return (
                            <td key={key(day)} className={`h-16 border-l border-divider p-1 align-top first:border-l-0 md:h-36 ${isToday ? "bg-accent-soft" : ""}`} aria-current={isToday ? "date" : undefined}>
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
                                  <Link href={href("day", day)} data-button-link className={`flex size-6 items-center justify-center rounded-full text-xs no-underline ${isToday ? "bg-accent font-bold text-on-accent hover:text-on-accent" : `font-medium hover:bg-subtle ${inMonth ? "text-ink" : "text-muted"}`}`} data-numeric>
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
                                        <CompactEntry e={e} staff={staff} />
                                      </li>
                                    ))}
                                  </ul>
                                ) : null}
                              </div>
                            </td>
                          );
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </Card>
              <Legend staff={staff} />
              <p className="m-0 text-xs text-muted md:hidden">Tap a day to see its details.</p>
            </>
          ) : view === "list" && staff && data.edit ? (
            data.entries.length === 0 ? (
              <Card pad={false}>
                <EmptyState title="No details in the next 60 days">Change the filters to see more.</EmptyState>
              </Card>
            ) : (
              <SelectableDetails
                types={data.edit.positionTypes}
                defaultTypeId={data.edit.defaultPositionTypeId ?? data.edit.positionTypes[0]?.id ?? ""}
                items={data.entries.map(
                  (e): SelectableItem => ({
                    id: e.id,
                    href: entryHref(e, true),
                    title: `#${e.number} ${e.title}`,
                    meta: `${e.vendorName}${e.locationName ? `, ${e.locationName}` : ""}. ${dayLabel(e.startAt)}`,
                    pay: e.pay,
                    chips: [
                      { tone: e.status === "open" ? "success" : e.status === "filled" ? "danger" : e.status === "not_released" ? "warning" : e.status === "requested" ? "coordinator" : "neutral", text: { open: "Open", filled: "Filled", not_released: "Not released", past: "Past", canceled: "Canceled", requested: "Vendor request" }[e.status] },
                      ...(e.held ? [{ tone: "warning" as const, text: "Held" }] : []),
                    ],
                    blocked: editBlockReason(e, now),
                  }),
                )}
              />
            )
          ) : (
            <>
              <DayList days={days} byDay={byDay} staff={staff} empty={view === "day" ? "No details this day" : view === "week" ? "No details this week" : "No details in the next 60 days"} />
              <Legend staff={staff} />
            </>
          )}

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
