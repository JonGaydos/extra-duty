import type { Cents } from "../types";

/** Job rate wins, then the vendor's default, then the agency default. */
export function resolveRate(jobRate: Cents | null, vendorDefault: Cents | null, agencyDefault: Cents): Cents {
  return jobRate ?? vendorDefault ?? agencyDefault;
}

/** The agency-wide hourly rate range; null means no limit on that side. */
export type RateRange = { rateMinCents: Cents | null; rateMaxCents: Cents | null };

/** "$70" or "$72.50". */
export function rateDollars(c: Cents): string {
  const whole = Math.floor(c / 100).toLocaleString("en-US");
  return c % 100 === 0 ? `$${whole}` : `$${whole}.${String(c % 100).padStart(2, "0")}`;
}

export function outsideRange(rate: Cents, r: RateRange): boolean {
  return (r.rateMinCents !== null && rate < r.rateMinCents) || (r.rateMaxCents !== null && rate > r.rateMaxCents);
}

/** "Rate must be between $50 and $90 an hour", or "at least" / "at most" when one side is open. */
export function rateRangeMessage(r: RateRange): string {
  if (r.rateMinCents !== null && r.rateMaxCents !== null) return `Rate must be between ${rateDollars(r.rateMinCents)} and ${rateDollars(r.rateMaxCents)} an hour`;
  if (r.rateMinCents !== null) return `Rate must be at least ${rateDollars(r.rateMinCents)} an hour`;
  if (r.rateMaxCents !== null) return `Rate must be at most ${rateDollars(r.rateMaxCents)} an hour`;
  return "";
}

/** A position's hourly rate: the detail's base rate plus the differential snapshotted on the position. */
export function positionRateCents(jobRateCents: Cents, position: { rateDifferentialCents: Cents }): Cents {
  return jobRateCents + position.rateDifferentialCents;
}
