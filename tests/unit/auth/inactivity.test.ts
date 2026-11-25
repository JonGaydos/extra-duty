import { describe, expect, test } from "vitest";
import { inactivityNotice, inactivityPeriodText, isInactive } from "@/domain/auth/inactivity";

describe("inactivity notice", () => {
  test("multiples of 30 days read as months", () => {
    expect(inactivityPeriodText(90)).toBe("3 months");
    expect(inactivityPeriodText(180)).toBe("6 months");
    expect(inactivityPeriodText(30)).toBe("1 month");
    expect(inactivityPeriodText(360)).toBe("12 months");
  });

  test("other periods read as days", () => {
    expect(inactivityPeriodText(45)).toBe("45 days");
    expect(inactivityPeriodText(1)).toBe("1 day");
    expect(inactivityPeriodText(100)).toBe("100 days");
  });

  test("full sentence follows the setting", () => {
    expect(inactivityNotice(90)).toBe("Accounts not signed in within the past 3 months require a password reset.");
    expect(inactivityNotice(180)).toBe("Accounts not signed in within the past 6 months require a password reset.");
    expect(inactivityNotice(45)).toBe("Accounts not signed in within the past 45 days require a password reset.");
  });
});

describe("isInactive", () => {
  const now = new Date("2026-11-22T12:00:00Z");
  const daysAgo = (d: number) => new Date(now.getTime() - d * 86_400_000);

  test("uses the last sign-in when there is one", () => {
    expect(isInactive({ lastSignInAt: daysAgo(89), createdAt: daysAgo(400), passwordSetAt: null }, 90, now)).toBe(false);
    expect(isInactive({ lastSignInAt: daysAgo(91), createdAt: daysAgo(400), passwordSetAt: null }, 90, now)).toBe(true);
  });

  test("falls back to account creation when never signed in", () => {
    expect(isInactive({ lastSignInAt: null, createdAt: daysAgo(10), passwordSetAt: null }, 90, now)).toBe(false);
    expect(isInactive({ lastSignInAt: null, createdAt: daysAgo(91), passwordSetAt: null }, 90, now)).toBe(true);
  });

  test("a recent password set or reset counts as activity", () => {
    expect(isInactive({ lastSignInAt: daysAgo(200), createdAt: daysAgo(400), passwordSetAt: daysAgo(1) }, 90, now)).toBe(
      false,
    );
  });
});
