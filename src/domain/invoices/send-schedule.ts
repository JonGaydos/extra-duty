/**
 * When batched invoices go to a vendor. Every date here is an agency calendar day as a YYYY-MM-DD key
 * (America/Chicago), so the math is plain calendar arithmetic with no clock times.
 */

export type SendSchedule = "immediate" | "weekly" | "every_2_weeks" | "monthly";

export type ScheduleAnchors = {
  /** 0 = Sunday; weekly and every-two-weeks sends. */
  invoiceSendDayOfWeek: number;
  /** Every-two-weeks phase: the first matching weekday on or after this date is a send day. */
  invoiceSendStartDate: string;
  /** Monthly sends; a day past the month's end uses its last day. */
  invoiceSendDayOfMonth: number;
};

const DAY_MS = 86_400_000;

const toUtc = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
};
const toKey = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const weekday = (ms: number) => new Date(ms).getUTCDay();
const lastDay = (y: number, m0: number) => new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();

/** The vendor's override when set, else the agency schedule. */
export function effectiveSchedule(vendorOverride: SendSchedule | null, s: { invoiceSendSchedule: SendSchedule }): SendSchedule {
  return vendorOverride ?? s.invoiceSendSchedule;
}

function monthlyDay(y: number, m0: number, dayOfMonth: number): number {
  return Date.UTC(y, m0, Math.min(dayOfMonth, lastDay(y, m0)));
}

/** True when `dayKey` is a send day for the schedule. Immediate has no send days. */
export function isSendDay(schedule: SendSchedule, a: ScheduleAnchors, dayKey: string): boolean {
  if (schedule === "immediate") return false;
  return nextSendDay(schedule, a, dayKey) === dayKey;
}

/** The first send day on or after `fromKey`. Immediate returns `fromKey`. */
export function nextSendDay(schedule: SendSchedule, a: ScheduleAnchors, fromKey: string): string {
  const from = toUtc(fromKey);
  if (schedule === "immediate") return fromKey;
  if (schedule === "monthly") {
    const d = new Date(from);
    const here = monthlyDay(d.getUTCFullYear(), d.getUTCMonth(), a.invoiceSendDayOfMonth);
    if (here >= from) return toKey(here);
    return toKey(monthlyDay(d.getUTCFullYear(), d.getUTCMonth() + 1, a.invoiceSendDayOfMonth));
  }
  const ahead = (a.invoiceSendDayOfWeek - weekday(from) + 7) % 7;
  const next = from + ahead * DAY_MS;
  if (schedule === "weekly") return toKey(next);
  const start = toUtc(a.invoiceSendStartDate);
  const base = start + ((a.invoiceSendDayOfWeek - weekday(start) + 7) % 7) * DAY_MS;
  const weeks = Math.round((next - base) / (7 * DAY_MS));
  return toKey(((weeks % 2) + 2) % 2 === 0 ? next : next + 7 * DAY_MS);
}

const LABEL: Record<Exclude<SendSchedule, "immediate">, string> = { weekly: "weekly", every_2_weeks: "every-two-weeks", monthly: "monthly" };
const dayFmt = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

/** "Fri, Nov 27" for a day key. */
export function sendDayLabel(dayKey: string): string {
  return dayFmt.format(new Date(toUtc(dayKey))).replace(/[  ]/g, " ");
}

/** What a payee reads on a queued invoice: "Queued for the weekly send on Fri, Nov 27." */
export function queuedSendText(schedule: Exclude<SendSchedule, "immediate">, dayKey: string): string {
  return `Queued for the ${LABEL[schedule]} send on ${sendDayLabel(dayKey)}.`;
}
