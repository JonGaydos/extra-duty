import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { withTx } from "@/ui/shell/request";
import { alertSettings } from "@/domain/personnel/views";
import { getCalendarFeedStatus } from "@/domain/planning/calendar";
import { getEarningsGoal, listHiddenVendors } from "@/domain/planning/preferences";
import { dutyIntervals, getWorkSchedule, listScheduleExceptions } from "@/domain/planning/schedule";
import { agencyDateOnly, agencyDateParts, agencyDayKey, agencyInstant } from "@/domain/time/agency-time";
import { getOwnContact } from "@/domain/users/contact";
import { getSettings } from "@/domain/settings/settings";
import { approvedW9, currentW9, dayText, type W9Row } from "@/domain/w9/w9";
import { openW9RequestsFor, readW9Lock, type W9Lock, type W9Request } from "@/domain/w9/requests";
import { signedText, W9StatusChip } from "../_shared/w9";
import { ActionLink } from "@/ui/components/Button";
import { Card, CardTitle } from "@/ui/components/Card";
import { Notice } from "@/ui/components/Notice";
import { MapsPreferenceControl } from "@/ui/components/MapsLink";
import { Icon } from "@/ui/icons";
import { loadShell } from "@/ui/shell/load-shell";
import { SignOutButton } from "@/ui/shell/SignOutButton";
import { ThemeToggle } from "@/ui/theme";
import { dateLabel, dateTime, dayLabel, hhmmText, monthDay } from "../_personnel/format";
import { HideVendorButton } from "../_personnel/HideVendorButton";
import { AlertPrefs, CalendarLinkForm, ContactForm, ExceptionForm, GoalForm, PushEnable, QuietHoursForm, RemoveException, ScheduleEditor, W9Upload } from "./forms";

export const metadata: Metadata = { title: "Profile" };

const DAY_MS = 86_400_000;

type Schedule = Awaited<ReturnType<typeof getWorkSchedule>>;
type ScheduleException = Awaited<ReturnType<typeof listScheduleExceptions>>[number];

/** A preview day: on duty, a day off, or neither. */
function dayClass(on: boolean, off: boolean): string {
  if (on) return "bg-accent font-semibold text-on-accent";
  return off ? "border-2 border-dashed border-warning-strong" : "bg-sunken text-muted";
}

/** "Day off on Tue, Dec 1" or "Extra shift 6 PM to 2 AM on Tue, Dec 1". */
function exceptionLabel(e: ScheduleException): string {
  const what = e.kind === "off" ? "Day off" : `Extra shift ${hhmmText(e.shiftStart ?? "")} to ${hhmmText(e.shiftEnd ?? "")}`;
  return `${what} on ${dayLabel(agencyDateOnly(e.date)!)}`;
}

/** The next four weeks of duty and leave, the upcoming days off and extra shifts, and the form to add one. */
function FourWeeks({
  days,
  dutyDays,
  leave,
  exceptions,
  today,
  weekStartsOn,
  weeksFrom,
  schedule,
}: Readonly<{
  days: Array<{ key: string; day: number }>;
  dutyDays: Set<string>;
  leave: Set<string>;
  exceptions: ScheduleException[];
  today: string;
  weekStartsOn: number;
  weeksFrom: Date;
  schedule: Schedule | undefined;
}>) {
  const leaveText = leave.size ? `, leave on ${[...leave].filter((k) => days.some((d) => d.key === k)).length} days` : "";
  return (
    <Card>
      <div className="flex items-baseline justify-between gap-2">
        <CardTitle>Next 4 weeks</CardTitle>
        <span className="text-sm text-muted">
          {monthDay(weeksFrom)} to {monthDay(new Date(weeksFrom.getTime() + 27 * DAY_MS))}
        </span>
      </div>
      <div
        role="img"
        aria-label={`Four week preview: ${days.filter((d) => dutyDays.has(d.key)).length} days on duty${leaveText}`}
        className="grid grid-cols-7 gap-1 text-center text-sm"
      >
        {Array.from({ length: 7 }, (_, i) => (weekStartsOn + i) % 7).map((day) => (
          <span key={day} aria-hidden className="text-xs font-semibold text-muted">
            {"SMTWTFS"[day]}
          </span>
        ))}
        {days.map((d) => {
          const on = dutyDays.has(d.key);
          const off = leave.has(d.key);
          return (
            <span
              key={d.key}
              aria-hidden
              className={`flex h-9 items-center justify-center rounded-xs ${dayClass(on, off)} ${d.key === today ? "outline-2 outline-offset-1 outline-ink" : ""}`}
              data-numeric
            >
              {d.day}
            </span>
          );
        })}
      </div>
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-xs bg-accent" /> On duty{schedule?.active ? ` ${hhmmText(schedule.shiftStart)} to ${hhmmText(schedule.shiftEnd)}` : ""}
        </span>
        <span className="flex items-center gap-1.5">
          <span className="size-3 rounded-xs border-2 border-dashed border-warning-strong" /> Day off
        </span>
      </p>
      {exceptions.filter((e) => e.date >= today).length > 0 ? (
        <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
          {exceptions
            .filter((e) => e.date >= today)
            .map((e) => {
              const label = exceptionLabel(e);
              return (
                <li key={e.id} className="flex items-center justify-between gap-2 py-1.5 text-sm">
                  <span>{label}</span>
                  <RemoveException id={e.id} label={label} />
                </li>
              );
            })}
        </ul>
      ) : null}
      <ExceptionForm today={today} />
    </Card>
  );
}

/** The linked Outlook calendar: when it last synced and why the last sync failed. */
function OutlookCard({ calendar }: Readonly<{ calendar: Awaited<ReturnType<typeof getCalendarFeedStatus>> }>) {
  return (
    <Card>
      <CardTitle>Outlook calendar</CardTitle>
      <p className="m-0 text-sm text-muted">Busy events and their titles are kept so you can see conflicts. Events marked Free are ignored.</p>
      {calendar.connected ? (
        <p className="m-0 text-sm">
          Linked.{" "}
          {calendar.lastFetchedAt ? `Last synced ${dateTime(calendar.lastFetchedAt)}.` : "Not synced yet."}
        </p>
      ) : null}
      {calendar.lastError ? <Notice tone="danger">Last sync failed: {calendar.lastError}</Notice> : null}
      <CalendarLinkForm connected={calendar.connected} />
    </Card>
  );
}

/** The W-9 on file and its review, with download and upload. A newer upload waiting for review does not replace an approved one. */
function W9Card({ w9 }: Readonly<{ w9: { latest: W9Row | null; approved: W9Row | null; requests: W9Request[]; lock: W9Lock } }>) {
  const { latest, approved, requests, lock } = w9;
  return (
    <Card id="w9" className="scroll-mt-24">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>W-9</CardTitle>
        {latest ? <W9StatusChip status={latest.status} /> : null}
      </div>
      {latest ? (
        <div className="flex flex-col gap-1 text-sm">
          <p className="m-0 flex flex-wrap items-center gap-x-3">
            Uploaded {dateLabel(latest.uploadedAt)}.
            <a href="/api/v1/me/w9" className="inline-flex min-h-11 items-center gap-1 font-semibold" download>
              <Icon name="download" size={16} />
              Download
            </a>
          </p>
          {latest.status === "approved" ? <p className="m-0 text-muted">{signedText(latest)}.</p> : null}
          {latest.status === "pending" ? <p className="m-0 text-muted">The extra duty office reviews it before it can go with an invoice.</p> : null}
          {latest.status === "rejected" ? <Notice tone="danger">Not approved: {latest.rejectReason}. Upload a corrected W-9 below.</Notice> : null}
          {latest.status !== "approved" && approved ? <p className="m-0 text-muted">Until then your approved W-9 from {dateLabel(approved.uploadedAt)} is used. {signedText(approved)}.</p> : null}
        </div>
      ) : (
        <p className="m-0 text-sm text-muted">No W-9 on file. You need an approved W-9 to sign up for details, and vendors often need one with your first invoice.</p>
      )}
      {requests.map((r) => (
        <Notice key={r.id} tone="warning">
          A new W-9 is due {dayText(r.dueOn)}.{r.note ? ` ${r.note}.` : ""} Upload it below; it has to be approved before then or sign-ups lock.
        </Notice>
      ))}
      {lock.locked ? <Notice tone="danger">{lock.message}.</Notice> : null}
      <W9Upload hasW9={latest !== null} />
    </Card>
  );
}

/** Profile: contact, W-9, schedule and its preview, calendar link, goal, hidden vendors, alerts, theme. */
export default async function ProfilePage() {
  const shell = await loadShell();
  if (!shell) redirect("/sign-in");
  const { actor, profile } = shell;
  const vendor = actor.role === "vendor";
  const now = new Date();
  const p = agencyDateParts(now);
  const { weekStartsOn } = await withTx((tx) => getSettings(tx));
  // The preview starts on the agency's first day of the week.
  const back = (new Date(Date.UTC(p.year, p.month - 1, p.day)).getUTCDay() - weekStartsOn + 7) % 7;
  const weeksFrom = agencyInstant(p.year, p.month, p.day - back, 0, 0);
  const weeksTo = new Date(weeksFrom.getTime() + 28 * DAY_MS + 2 * 3_600_000);

  const data = vendor
    ? null
    : await withTx(async (tx) => {
        const schedule = await getWorkSchedule(actor, tx, actor.userId);
        const exceptions = await listScheduleExceptions(actor, tx, actor.userId);
        const duty = schedule ? dutyIntervals([{ ...schedule, bufferMinutes: 0 }], exceptions, weeksFrom, weeksTo) : dutyIntervals([], exceptions, weeksFrom, weeksTo);
        return {
          contact: await getOwnContact(actor, tx),
          w9: {
            latest: await currentW9(tx, actor.userId),
            approved: await approvedW9(tx, actor.userId),
            requests: await openW9RequestsFor(tx, actor.userId, now),
            lock: await readW9Lock(tx, actor.userId, now),
          },
          schedule,
          exceptions,
          dutyDays: new Set(duty.map((d) => agencyDayKey(d.startAt))),
          calendar: await getCalendarFeedStatus(actor, tx, actor.userId),
          goal: await getEarningsGoal(actor, tx, actor.userId),
          hidden: await listHiddenVendors(actor, tx, actor.userId),
          alerts: await alertSettings(actor, tx),
        };
      });

  const today = agencyDayKey(now);
  const days = Array.from({ length: 28 }, (_, i) => {
    const d = agencyDateParts(new Date(weeksFrom.getTime() + i * DAY_MS + 12 * 3_600_000));
    return { key: `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`, day: d.day };
  });
  const leave = new Set(data?.exceptions.filter((e) => e.kind === "off").map((e) => e.date));
  const sch = data?.schedule;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1">
        <h1 className="m-0 text-2xl font-bold md:text-3xl">Profile</h1>
        <span className="text-muted">{profile.name}</span>
      </div>
      <div className="grid gap-4.5 md:grid-cols-2 md:items-start md:gap-6">
        <div className="flex flex-col gap-4.5">
          {data ? (
            <>
              <Card id="schedule">
                <CardTitle>My schedule</CardTitle>
                <p className="m-0 text-sm text-muted">Private to you. Used to show only details you can work and to recommend details.</p>
                <ScheduleEditor
                  initial={{
                    kind: sch?.kind ?? "rotation",
                    weekdays: sch?.weekdays ?? [1, 2, 3, 4, 5],
                    cycle: sch?.cycle ?? "11001110011000",
                    anchorDate: sch?.anchorDate ?? today,
                    shiftStart: sch?.shiftStart ?? "18:00",
                    shiftEnd: sch?.shiftEnd ?? "06:00",
                    bufferMinutes: sch?.bufferMinutes ?? 30,
                    active: sch?.active ?? false,
                  }}
                />
              </Card>

              <FourWeeks days={days} dutyDays={data.dutyDays} leave={leave} exceptions={data.exceptions} today={today} weekStartsOn={weekStartsOn} weeksFrom={weeksFrom} schedule={sch} />

              <OutlookCard calendar={data.calendar} />
            </>
          ) : null}
        </div>

        <div className="flex flex-col gap-4.5">
          {data ? (
            <>
              <Card id="contact">
                <CardTitle>Contact</CardTitle>
                <dl className="m-0 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
                  <dt className="text-muted">Name</dt>
                  <dd className="m-0">{data.contact.name}</dd>
                  <dt className="text-muted">Email</dt>
                  <dd className="m-0 break-all">{data.contact.email}</dd>
                </dl>
                <p className="m-0 text-xs text-muted">To change your name or email, contact the extra duty office.</p>
                <ContactForm phone={data.contact.phone ?? ""} mailingAddress={data.contact.mailingAddress ?? ""} />
              </Card>

              <W9Card w9={data.w9} />

              <Card id="goal">
                <CardTitle>Goal and hidden vendors</CardTitle>
                <GoalForm dollars={data.goal === null ? "" : String(data.goal / 100)} />
                <div className="flex flex-col gap-1.5 border-t border-divider pt-3">
                  <h3 className="m-0 text-sm font-semibold">Hidden vendors</h3>
                  {data.hidden.length === 0 ? (
                    <p className="m-0 text-sm text-muted">None. Use Hide this vendor on a detail to take a vendor off your lists.</p>
                  ) : (
                    <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
                      {data.hidden.map((h) => (
                        <li key={h.vendorId} className="flex items-center justify-between gap-2 py-1">
                          <span>{h.name}</span>
                          <HideVendorButton vendorId={h.vendorId} vendorName={h.name} undo compact />
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              </Card>

              <Card id="alerts">
                <CardTitle>Alerts</CardTitle>
                <AlertPrefs types={data.alerts.types} prefs={data.alerts.prefs} agencyOff={data.alerts.agencyOff} />
                <div className="flex flex-col gap-2 border-t border-divider pt-3">
                  <h3 className="m-0 text-sm font-semibold">Quiet hours</h3>
                  <QuietHoursForm enabled={data.alerts.quietHours.enabled} start={data.alerts.quietHours.start} end={data.alerts.quietHours.end} />
                </div>
                <div className="flex flex-col gap-2 border-t border-divider pt-3">
                  <h3 className="m-0 text-sm font-semibold">Push alerts</h3>
                  <PushEnable vapidKey={process.env.VAPID_PUBLIC_KEY ?? null} devices={data.alerts.pushDevices} />
                </div>
              </Card>
            </>
          ) : null}

          <Card id="maps">
            <CardTitle>Maps</CardTitle>
            <p className="m-0 text-muted">The app Open in Maps uses for addresses. Ask each time shows Google Maps, Apple Maps and OpenStreetMap.</p>
            <MapsPreferenceControl />
          </Card>
          <Card>
            <CardTitle>Theme</CardTitle>
            <p className="m-0 text-muted">System follows your device. Day or Night applies on every device you sign in to.</p>
            <ThemeToggle initial={profile.themePreference} signedIn />
          </Card>
          <Card>
            <CardTitle>Help</CardTitle>
            <p className="m-0 text-muted">Step-by-step guides with pictures for everything you do in Signal 90.</p>
            <ActionLink href="/help">Help and user manual</ActionLink>
          </Card>
          <Card>
            <CardTitle>Sign out</CardTitle>
            <p className="m-0 text-muted">Signing out here does not sign you out on your other devices.</p>
            <SignOutButton />
          </Card>
        </div>
      </div>
    </div>
  );
}
