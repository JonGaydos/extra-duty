const DAY_MS = 86_400_000;

/** 90 -> "3 months", 180 -> "6 months"; periods that are not whole 30-day months read as days. */
export function inactivityPeriodText(days: number): string {
  if (days % 30 === 0) {
    const months = days / 30;
    return `${months} ${months === 1 ? "month" : "months"}`;
  }
  return `${days} ${days === 1 ? "day" : "days"}`;
}

/** The notice shown beside "Forgot password?" on the sign-in page. */
export function inactivityNotice(days: number): string {
  return `Accounts not signed in within the past ${inactivityPeriodText(days)} require a password reset.`;
}

export type ActivityDates = {
  lastSignInAt: Date | null;
  /** Account creation, used when the person has never signed in. */
  createdAt: Date;
  /** When the password was last set (invite acceptance or reset). */
  passwordSetAt: Date | null;
};

/**
 * True when the latest of last sign-in (or account creation when never signed
 * in) and the last password set is more than `lockDays` before `now`.
 * A password set counts so that a completed self-service reset unlocks.
 */
export function isInactive(d: ActivityDates, lockDays: number, now: Date): boolean {
  const base = Math.max((d.lastSignInAt ?? d.createdAt).getTime(), d.passwordSetAt?.getTime() ?? 0);
  return now.getTime() - base > lockDays * DAY_MS;
}
