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
import { currentW9 } from "@/domain/w9/w9";
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

const ALERT_TYPES = [
  { type: "spot.offered", label: "A backup spot is offered to you" },
  { type: "spot.opened_first_come", label: "A spot opens for anyone" },
  { type: "job.watch_opened", label: "A detail you watch opens" },
  { type: "job.watch_released", label: "A detail you watch is released" },
  { type: "job.changed", label: "A detail you are on changes" },
  { type: "job.canceled", label: "A detail you are on is canceled" },
  { type: "job.reactivated", label: "A canceled detail you were on is back on" },
  { type: "job.safety_changed", label: "Officer safety information changes" },
  { type: "assignment.assigned", label: "A coordinator assigns you" },
  { type: "assignment.removed", label: "A coordinator removes you" },
  { type: "signup.short_confirmed", label: "A shorter shift is confirmed" },
  { type: "signup.short_declined", label: "A shorter shift is declined" },
  { type: "billing.ready", label: "A detail is ready to bill" },
  { type: "billing.unbilled_reminder", label: "Reminders about unbilled details" },
  { type: "invoice.returned", label: "An invoice is sent back to you" },
  { type: "invoice.vendor_paid", label: "A vendor reports paying you" },
  { type: "payment_issue.waiting_on", label: "A payment issue needs you" },
  { type: "ops_plan.due", label: "An ops plan is due" },
  { type: "message.received", label: "You get a message" },
];

const DAY_MS = 86_400_000;

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
          w9: await currentW9(tx, actor.userId),
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

              <Card>
                <div className="flex items-baseline justify-between gap-2">
                  <CardTitle>Next 4 weeks</CardTitle>
                  <span className="text-sm text-muted">
                    {monthDay(weeksFrom)} to {monthDay(new Date(weeksFrom.getTime() + 27 * DAY_MS))}
                  </span>
                </div>
                <div
                  role="img"
                  aria-label={`Four week preview: ${days.filter((d) => data.dutyDays.has(d.key)).length} days on duty${leave.size ? `, leave on ${[...leave].filter((k) => days.some((d) => d.key === k)).length} days` : ""}`}
                  className="grid grid-cols-7 gap-1 text-center text-sm"
                >
                  {Array.from({ length: 7 }, (_, i) => ["S", "M", "T", "W", "T", "F", "S"][(weekStartsOn + i) % 7]).map((w, i) => (
                    <span key={i} aria-hidden className="text-xs font-semibold text-muted">
                      {w}
                    </span>
                  ))}
                  {days.map((d) => {
                    const on = data.dutyDays.has(d.key);
                    const off = leave.has(d.key);
                    return (
                      <span
                        key={d.key}
                        aria-hidden
                        className={`flex h-9 items-center justify-center rounded-xs ${on ? "bg-accent font-semibold text-on-accent" : off ? "border-2 border-dashed border-warning-strong" : "bg-sunken text-muted"} ${d.key === today ? "outline-2 outline-offset-1 outline-ink" : ""}`}
                        data-numeric
                      >
                        {d.day}
                      </span>
                    );
                  })}
                </div>
                <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="size-3 rounded-xs bg-accent" /> On duty{sch?.active ? ` ${hhmmText(sch.shiftStart)} to ${hhmmText(sch.shiftEnd)}` : ""}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="size-3 rounded-xs border-2 border-dashed border-warning-strong" /> Day off
                  </span>
                </p>
                {data.exceptions.filter((e) => e.date >= today).length > 0 ? (
                  <ul className="m-0 flex list-none flex-col divide-y divide-divider p-0">
                    {data.exceptions
                      .filter((e) => e.date >= today)
                      .map((e) => {
                        const label = `${e.kind === "off" ? "Day off" : `Extra shift ${hhmmText(e.shiftStart ?? "")} to ${hhmmText(e.shiftEnd ?? "")}`} on ${dayLabel(agencyDateOnly(e.date)!)}`;
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

              <Card>
                <CardTitle>Outlook calendar</CardTitle>
                <p className="m-0 text-sm text-muted">Busy events and their titles are kept so you can see conflicts. Events marked Free are ignored.</p>
                {data.calendar.connected ? (
                  <p className="m-0 text-sm">
                    Linked.{" "}
                    {data.calendar.lastFetchedAt ? `Last synced ${dateTime(data.calendar.lastFetchedAt)}.` : "Not synced yet."}
                  </p>
                ) : null}
                {data.calendar.lastError ? <Notice tone="danger">Last sync failed: {data.calendar.lastError}</Notice> : null}
                <CalendarLinkForm connected={data.calendar.connected} />
              </Card>
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

              <Card>
                <CardTitle>W-9</CardTitle>
                {data.w9 ? (
                  <p className="m-0 flex flex-wrap items-center gap-x-3 text-sm">
                    Uploaded {dateLabel(data.w9.uploadedAt)}.
                    <a href="/api/v1/me/w9" className="inline-flex min-h-11 items-center gap-1 font-semibold" download>
                      <Icon name="download" size={16} />
                      Download
                    </a>
                  </p>
                ) : (
                  <p className="m-0 text-sm text-muted">No W-9 on file. Vendors often need one with your first invoice.</p>
                )}
                <W9Upload hasW9={data.w9 !== null} />
              </Card>

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
                <AlertPrefs types={ALERT_TYPES} prefs={data.alerts.prefs} agencyOff={data.alerts.agencyOff} />
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
            <p className="m-0 text-muted">Step-by-step guides with pictures for everything you do in Extra Duty.</p>
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
