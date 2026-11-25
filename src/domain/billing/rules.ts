import { ValidationError } from "@/domain/errors";
import { AGENCY_TZ, minutesBetween } from "@/domain/time/agency-time";
import type { Cents, Minutes } from "@/domain/types";

type Span = { startAt: Date; endAt: Date };

/** Rounds up to the next multiple of `step`. */
export function roundMinutes(minutes: Minutes, step: number): Minutes {
  if (!Number.isInteger(minutes) || minutes < 0) throw new ValidationError("Minutes must be a non-negative integer");
  if (!Number.isInteger(step) || step <= 0) throw new ValidationError("Rounding step must be a positive integer");
  return Math.ceil(minutes / step) * step;
}

/** Job override, then vendor override, then agency setting. */
export function resolveMinimum(jobMin: Minutes | null, vendorMin: Minutes | null, agencyMin: Minutes): Minutes {
  return jobMin ?? vendorMin ?? agencyMin;
}

/** Rounds up first, then applies the (already resolved) minimum. */
export function billableMinutes(
  actual: Minutes,
  s: { minimumBillableMinutes: number; hourRoundingMinutes: number },
): Minutes {
  return Math.max(roundMinutes(actual, s.hourRoundingMinutes), s.minimumBillableMinutes);
}

export function invoiceTotal(minutes: Minutes, rateCents: Cents): Cents {
  if (!Number.isInteger(minutes) || minutes < 0) throw new ValidationError("Minutes must be a non-negative integer");
  if (!Number.isInteger(rateCents) || rateCents < 0) throw new ValidationError("Rate must be a non-negative integer");
  return Math.round((minutes * rateCents) / 60);
}

/** Compares against the assignment's planned times, by instant. */
export function hoursChanged(planned: Span, actual: Span): boolean {
  return (
    planned.startAt.getTime() !== actual.startAt.getTime() || planned.endAt.getTime() !== actual.endAt.getTime()
  );
}

export function reviewDecision(mode: "immediate" | "changed_hours_only" | "all", changed: boolean): "send" | "hold" {
  if (mode === "immediate") return "send";
  if (mode === "all") return "hold";
  return changed ? "hold" : "send";
}

export function lateCancelMinutes(
  job: Span,
  s: {
    lateCancelPayBasis: "minimum" | "scheduled";
    minimumBillableMinutes: Minutes;
    hourRoundingMinutes: number;
  },
): Minutes {
  if (s.lateCancelPayBasis === "minimum") return s.minimumBillableMinutes;
  return billableMinutes(minutesBetween(job.startAt, job.endAt), s);
}

const BILL_DAY = new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, month: "short", day: "numeric", year: "numeric" });
const BILL_TIME = new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, hour: "numeric", minute: "2-digit" });

/**
 * Nothing is billed before the detail's scheduled end, late-cancel pay included: "You can bill late-cancel pay after
 * Nov 25, 2026 at 3:38 PM", in agency time.
 */
export function lateCancelBillableText(endAt: Date): string {
  return `You can bill late-cancel pay after ${BILL_DAY.format(endAt)} at ${BILL_TIME.format(endAt)}`;
}
