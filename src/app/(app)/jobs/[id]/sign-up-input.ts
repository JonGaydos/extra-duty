import type { CheckResult } from "@/domain/errors";
import { shownChecks } from "@/domain/eligibility/eligibility";
import type { CapUse } from "@/domain/personnel/views";
import { clock, hoursText, timeRange, wholeHours } from "../../_personnel/format";
import type { JobPageData } from "./load";
import type { PositionChoice, TimeOption } from "./SignUpPanel";

const QUARTER = 15 * 60_000;

/** What a met rule says (a failing rule shows the service's exact message instead). */
function passLabel(c: CheckResult, windowHours: number): string {
  switch (c.check) {
    case "state":
      return "Open for sign-up";
    case "vendor_hold":
      return "Vendor in good standing";
    case "vendor_restricted":
      return "Available to you";
    case "rank":
      return "Your rank qualifies";
    case "qualification":
      return "You have the required flags";
    case "active":
      return "Your account is active";
    case "billing_lock":
      return "Billing is up to date";
    case "w9":
      return "Your W-9 is approved";
    case "message_ack":
      return "Messages acknowledged";
    case "overlap":
      return "No overlap with your other details";
    case "cap_rolling":
      return `Within the ${windowHours}-hour cap`;
    case "cap_week":
      return "Within the week cap";
    case "cap_month":
      return "Within the month cap";
    case "already_on_job":
      return "Not already on this detail";
    default:
      return c.message || c.check;
  }
}

/** Each position the person may sign up for, with every rule and, for the caps, their current hours. */
export function positionChoices(d: JobPageData): PositionChoice[] {
  const { caps, card, settings } = d;
  // Cap rules always show the person's current hours, so a passing cap still says how close it is.
  const capUse: Record<string, CapUse> = { cap_rolling: caps.rolling, cap_week: caps.week, cap_month: caps.month };
  const capDetail = (c: CheckResult) => {
    const use = capUse[c.check];
    if (!use) return undefined;
    return use.limitMinutes === null ? `${wholeHours(use.usedMinutes)} h now, no cap` : `${wholeHours(use.usedMinutes)} / ${wholeHours(use.limitMinutes)} h now`;
  };
  return d.eligibility.map((e) => {
    const pos = card.positions.find((p) => p.id === e.jobPositionId);
    return {
      id: e.jobPositionId,
      name: pos?.name ?? "Position",
      open: pos ? Math.max(0, pos.count - pos.filled) : 0,
      offered: pos?.offered ?? 0,
      canSignUp: e.canSignUp,
      canBackup: e.canBackup,
      checks: shownChecks(e.checks).map((c) => ({ label: c.ok ? passLabel(c, settings.rollingCapWindowHours) : c.message, ok: c.ok, cap: c.check in capUse, detail: capDetail(c) })),
    };
  });
}

/** A flexible detail's start and end choices in 15-minute steps, for someone not on it yet; null otherwise. */
export function flexChoices(d: JobPageData) {
  const { card, job, settings } = d;
  if (!card.flex || d.mine) return null;
  const starts: TimeOption[] = [];
  const ends: TimeOption[] = [];
  for (let t = card.flex.earliestStartAt.getTime(); t <= card.flex.latestEndAt.getTime(); t += QUARTER) {
    const at = new Date(t);
    if (t < card.flex.latestEndAt.getTime()) starts.push({ value: at.toISOString(), label: clock(at) });
    if (t > card.flex.earliestStartAt.getTime()) ends.push({ value: at.toISOString(), label: clock(at) });
  }
  return {
    starts,
    ends,
    start: job.startAt.toISOString(),
    end: job.endAt.toISOString(),
    rangeText: timeRange(card.flex.earliestStartAt, card.flex.latestEndAt),
    shorterNote: card.flex.allowShorter
      ? `Shorter than ${hoursText(card.minutes)} stays pending until ${settings.shortShiftWindowHours} hours before the start.`
      : `Keep the full ${hoursText(card.minutes)}.`,
  };
}
