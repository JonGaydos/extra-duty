import type { Metadata } from "next";
import Link from "next/link";
import { withTx } from "@/ui/shell/request";
import { getSettings } from "@/domain/settings/settings";
import { agencyDateParts, agencyDayKey, agencyInstant } from "@/domain/time/agency-time";
import { VENDOR_STATUS_LABEL, vendorAccount, vendorDetails, type VendorDetailRow } from "@/domain/vendor-portal/views";
import { ButtonLink } from "@/ui/components/Button";
import { Card } from "@/ui/components/Card";
import { EmptyState } from "@/ui/components/EmptyState";
import { Icon } from "@/ui/icons";
import { clock, longDay, monthYear, plural } from "../_personnel/format";
import { PageTitle, Section, TabLinks } from "../_personnel/TabLinks";
import { DetailRows } from "./_vendor/DetailRows";
import { vendorActor } from "./_vendor/session";

export const metadata: Metadata = { title: "My details" };

type Props = { searchParams: Promise<Record<string, string | string[] | undefined>> };

const DAY_MS = 86_400_000;
const PAST_DAYS = 60;
const AHEAD_DAYS = 400;

type Ymd = { y: number; m: number; d: number };
const add = (a: Ymd, days: number, months = 0): Ymd => {
  const t = new Date(Date.UTC(a.y, a.m - 1 + months, a.d + days));
  return { y: t.getUTCFullYear(), m: t.getUTCMonth() + 1, d: t.getUTCDate() };
};
const key = (a: Ymd) => `${a.y}-${String(a.m).padStart(2, "0")}-${String(a.d).padStart(2, "0")}`;
const startOf = (a: Ymd) => agencyInstant(a.y, a.m, a.d, 0, 0);
const weekday = (a: Ymd) => new Date(Date.UTC(a.y, a.m - 1, a.d)).getUTCDay();

/** The vendor's details as a list (waiting, upcoming, recent) or a month calendar. */
export default async function VendorDetailsPage({ searchParams }: Readonly<Props>) {
  const actor = await vendorActor();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? "";
  const view = one(sp.view) === "calendar" ? "calendar" : "list";
  const now = new Date();
  const today = agencyDateParts(now);
  const monthParam = /^(\d{4})-(\d{2})$/.exec(one(sp.month));
  const focus: Ymd = monthParam ? { y: Number(monthParam[1]), m: Math.min(12, Math.max(1, Number(monthParam[2]))), d: 1 } : { y: today.year, m: today.month, d: 1 };

  const settings = await withTx((tx) => getSettings(tx));
  const firstCell = add(focus, -((weekday(focus) - settings.weekStartsOn + 7) % 7));
  const cells = Math.ceil(Math.round((startOf(add(focus, 0, 1)).getTime() - startOf(firstCell).getTime()) / DAY_MS) / 7) * 7;
  const days = Array.from({ length: cells }, (_, i) => add(firstCell, i));
  const range = view === "calendar" ? { from: startOf(days[0]), to: startOf(add(days.at(-1)!, 1)) } : { from: new Date(now.getTime() - PAST_DAYS * DAY_MS), to: new Date(now.getTime() + AHEAD_DAYS * DAY_MS) };

  const data = await withTx(async (tx) => ({ account: await vendorAccount(actor, tx), rows: await vendorDetails(actor, tx, range, now) }));
  const { account, rows } = data;

  return (
    <div className="flex flex-col gap-4.5">
      <PageTitle sub={account.name} action={account.onHold ? undefined : <ButtonLink href="/vendor/request">Request a detail</ButtonLink>}>
        My details
      </PageTitle>
      {account.onHold ? (
        <Card tone="danger">
          <p className="m-0 font-semibold text-danger-ink">Your account is on payment hold</p>
          <p className="m-0 text-sm text-danger-ink">Upcoming details are locked, and new requests and changes are paused until the hold is resolved. Call the coordinators.</p>
        </Card>
      ) : null}
      <TabLinks
        label="Details views"
        current={view}
        items={[
          { key: "list", label: "List", href: "/vendor" },
          { key: "calendar", label: "Calendar", href: "/vendor?view=calendar" },
        ]}
      />

      {view === "list" ? (
        <ListView rows={rows} now={now} onHold={account.onHold} />
      ) : (
        <MonthView focus={focus} days={days} rows={rows} today={agencyDayKey(now)} />
      )}
    </div>
  );
}

/** Waiting for approval, upcoming and recent details, or what will show here. */
function ListView({ rows, now, onHold }: Readonly<{ rows: VendorDetailRow[]; now: Date; onHold: boolean }>) {
  if (rows.length === 0)
    return (
      <Card pad={false}>
        <EmptyState title="No details yet" action={onHold ? undefined : <ButtonLink href="/vendor/request">Request a detail</ButtonLink>}>
          Details you request show here once you send them.
        </EmptyState>
      </Card>
    );
  const waiting = rows.filter((r) => r.status === "requested" && r.endAt > now);
  const upcoming = rows.filter((r) => r.status !== "requested" && r.status !== "past" && r.endAt > now);
  const recent = rows.filter((r) => r.endAt <= now).reverse();
  return (
    <>
      {waiting.length ? (
        <Section title="Waiting for approval">
          <DetailRows rows={waiting} />
        </Section>
      ) : null}
      <Section title="Upcoming">
        {upcoming.length ? (
          <DetailRows rows={upcoming} />
        ) : (
          <Card>
            <p className="m-0 text-sm text-muted">Nothing scheduled yet. Approved requests show here.</p>
          </Card>
        )}
      </Section>
      {recent.length ? (
        <Section title={`Past ${PAST_DAYS} days`}>
          <DetailRows rows={recent} />
        </Section>
      ) : null}
    </>
  );
}

/** The day number: filled for today, muted outside the month. */
function dayNumberClass(isToday: boolean, outside: boolean): string {
  if (isToday) return "bg-accent font-bold text-on-accent";
  return `font-medium ${outside ? "text-muted" : "text-ink"}`;
}

function MonthView({ focus, days, rows, today }: Readonly<{ focus: Ymd; days: Ymd[]; rows: VendorDetailRow[]; today: string }>) {
  const byDay = new Map<string, VendorDetailRow[]>();
  for (const r of rows) byDay.set(agencyDayKey(r.startAt), [...(byDay.get(agencyDayKey(r.startAt)) ?? []), r]);
  const title = monthYear(startOf(focus));
  const monthKey = (a: Ymd) => key(a).slice(0, 7);
  const href = (a: Ymd) => `/vendor?view=calendar&month=${monthKey(a)}`;
  const weekdays = days.slice(0, 7).map((d) => new Intl.DateTimeFormat("en-US", { weekday: "short", timeZone: "UTC" }).format(new Date(Date.UTC(d.y, d.m - 1, d.d))));
  const inMonth = rows.filter((r) => agencyDayKey(r.startAt).slice(0, 7) === monthKey(focus));
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <Link href={href(add(focus, 0, -1))} aria-label="Previous month" data-button-link className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink">
          <Icon name="chevronLeft" size={20} />
        </Link>
        <h2 className="m-0 text-title font-semibold md:text-base">{title}</h2>
        <Link href={href(add(focus, 0, 1))} aria-label="Next month" data-button-link className="flex size-11 items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink">
          <Icon name="chevronRight" size={20} />
        </Link>
      </div>
      {/* Each cell is positioned, so a screen-reader-only label after a long title stays inside it (and inside the
          card's clip) instead of pushing the page sideways in some months. */}
      <Card pad={false} className="overflow-hidden">
        <table className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">{title}: your details by day</caption>
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
                  const isToday = key(day) === today;
                  const outside = day.m !== focus.m;
                  return (
                    <td key={key(day)} aria-current={isToday ? "date" : undefined} className={`relative h-14 border-l border-divider p-1 align-top first:border-l-0 md:h-32 ${isToday ? "bg-accent-soft" : ""}`}>
                      <div className="flex h-full flex-col items-center gap-0.5 md:items-stretch">
                        <span className="flex items-center justify-between gap-1">
                          <span className={`flex size-6 items-center justify-center rounded-full text-xs ${dayNumberClass(isToday, outside)}`} data-numeric>
                            <span aria-hidden>{day.d}</span>
                            <span className="sr-only">
                              {longDay(startOf(day))}
                              {isToday ? ", today" : ""}, {plural(list.length, "detail")}
                            </span>
                          </span>
                        </span>
                        {list.length ? (
                          <>
                            <span aria-hidden className="rounded-full bg-sunken px-1.5 text-micro font-semibold md:hidden" data-numeric>
                              {list.length}
                            </span>
                            <ul className="m-0 hidden max-h-24 list-none flex-col overflow-y-auto p-0 md:flex">
                              {list.map((d) => (
                                <li key={d.id}>
                                  <Link
                                    href={`/vendor/details/${d.id}`}
                                    title={d.title}
                                    data-card-link
                                    className="group flex min-h-6 rounded-xs px-0.5 py-0.5 text-xs text-ink no-underline hover:bg-subtle hover:text-ink"
                                  >
                                    <span className={`min-w-0 truncate ${d.status === "canceled" || d.status === "declined" ? "text-muted line-through" : ""}`}>
                                      <span className="font-semibold" data-numeric>
                                        {clock(d.startAt)}
                                      </span>{" "}
                                      <span className="underline decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2">{d.title}</span>
                                      <span className="sr-only">. {VENDOR_STATUS_LABEL[d.status]}</span>
                                    </span>
                                  </Link>
                                </li>
                              ))}
                            </ul>
                          </>
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
      {/* Phones: the month's details as a list under the grid. */}
      <div className="flex flex-col gap-2.5 md:hidden">
        <h2 className="m-0 text-title font-semibold">This month</h2>
        {inMonth.length ? (
          <DetailRows rows={inMonth} />
        ) : (
          <Card>
            <p className="m-0 text-sm text-muted">No details in {title}.</p>
          </Card>
        )}
      </div>
      {inMonth.length ? null : <p className="m-0 hidden text-sm text-muted md:block">No details in {title}.</p>}
    </div>
  );
}
