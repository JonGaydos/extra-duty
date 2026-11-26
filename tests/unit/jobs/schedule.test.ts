import { describe, expect, test, vi } from "vitest";
import { SCHEDULE, runTick, type ScheduledTick } from "@/jobs/schedule";
import { byText } from "@/lib/sort";

// Test jobs are async to match the job runner; they answer at once.

const names = (cron: string) => SCHEDULE.filter((t) => t.cron === cron).map((t) => t.name).sort(byText);

describe("job schedule", () => {
  test("every minute: short confirmations, backup offers, watch releases, billing alerts", () => {
    expect(names("* * * * *")).toEqual(["backup-offer", "billing-ready", "confirm-pending-short", "watch-release"]);
  });

  test("daily at 3:20 AM: calendar feeds", () => {
    expect(names("20 3 * * *")).toEqual(["calendar-feeds"]);
  });

  test("daily at 7:10 AM: response deadlines", () => {
    expect(names("10 7 * * *")).toEqual(["response-deadlines"]);
  });

  test("daily at 7:20 AM: the Send invoices alert for due vendor batches", () => {
    expect(names("20 7 * * *")).toEqual(["invoice-batches-due"]);
  });

  test("daily at 7:40 AM: ops plan reminders", () => {
    expect(names("40 7 * * *")).toEqual(["ops-plan-reminders"]);
  });

  test("daily at 8:10 AM: unbilled reminders", () => {
    expect(names("10 8 * * *")).toEqual(["unbilled-reminders"]);
  });

  test("daily at 2:10 AM: suspensions, inactivity, contracts, access review, old sign-in attempts", () => {
    expect(names("10 2 * * *")).toEqual(["access-review", "auth-throttle-prune", "contract-expiry", "inactivity-lock", "lift-expired-suspensions"]);
    // Sign-in attempts live only in the live database.
    expect(SCHEDULE.find((t) => t.name === "auth-throttle-prune")!.modes).toEqual(["live"]);
  });

  test("daily at 2:00 AM, training only: the training reset", () => {
    expect(names("0 2 * * *")).toEqual(["training-reset"]);
    expect(SCHEDULE.find((t) => t.name === "training-reset")!.modes).toEqual(["training"]);
  });

  test("every entry runs in agency time and names are unique", () => {
    expect(SCHEDULE.every((t) => t.tz === "America/Chicago")).toBe(true);
    expect(new Set(SCHEDULE.map((t) => t.name)).size).toBe(SCHEDULE.length);
    expect(SCHEDULE).toHaveLength(15);
  });

  test("a failing tick is logged and does not throw, so the others still run", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ok = vi.fn(async () => {});
    const bad: ScheduledTick = { name: "bad", cron: "* * * * *", tz: "America/Chicago", run: () => Promise.reject(new Error("boom")) };
    const good: ScheduledTick = { name: "good", cron: "* * * * *", tz: "America/Chicago", run: ok };
    for (const t of [bad, good]) await runTick(t);
    expect(ok).toHaveBeenCalledTimes(1);
    expect(log).toHaveBeenCalledTimes(1);
    log.mockRestore();
  });
});
