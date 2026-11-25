import { describe, expect, test } from "vitest";
import { effectiveSchedule, isSendDay, nextSendDay, queuedSendText } from "@/domain/invoices/send-schedule";

/** Fridays; every two weeks from Fri Jan 2, 2026; monthly on the 31st. */
const anchors = { invoiceSendDayOfWeek: 5, invoiceSendStartDate: "2026-01-02", invoiceSendDayOfMonth: 31 };

describe("invoice send schedule", () => {
  test("a vendor override wins over the agency schedule; null uses the agency's", () => {
    expect(effectiveSchedule(null, { invoiceSendSchedule: "weekly" })).toBe("weekly");
    expect(effectiveSchedule("monthly", { invoiceSendSchedule: "weekly" })).toBe("monthly");
    expect(effectiveSchedule("immediate", { invoiceSendSchedule: "every_2_weeks" })).toBe("immediate");
  });

  test("weekly sends on the configured day of the week", () => {
    expect(nextSendDay("weekly", anchors, "2026-11-23")).toBe("2026-11-27");
    expect(nextSendDay("weekly", anchors, "2026-11-27")).toBe("2026-11-27");
    expect(nextSendDay("weekly", anchors, "2026-11-28")).toBe("2026-12-04");
    expect(isSendDay("weekly", anchors, "2026-11-27")).toBe(true);
    expect(isSendDay("weekly", anchors, "2026-11-26")).toBe(false);
  });

  test("every two weeks keeps the phase of the start date, before and after it", () => {
    expect(nextSendDay("every_2_weeks", anchors, "2026-11-21")).toBe("2026-12-04");
    expect(nextSendDay("every_2_weeks", anchors, "2026-11-20")).toBe("2026-11-20");
    expect(isSendDay("every_2_weeks", anchors, "2026-11-27")).toBe(false);
    expect(isSendDay("every_2_weeks", anchors, "2025-12-19")).toBe(true);
    // A start date on another weekday anchors the first matching weekday on or after it.
    const wed = { ...anchors, invoiceSendStartDate: "2025-12-31" };
    expect(nextSendDay("every_2_weeks", wed, "2026-11-21")).toBe("2026-12-04");
  });

  test("monthly clamps the day to the month's last day", () => {
    expect(nextSendDay("monthly", anchors, "2027-02-01")).toBe("2027-02-28");
    expect(nextSendDay("monthly", anchors, "2026-11-23")).toBe("2026-11-30");
    expect(nextSendDay("monthly", anchors, "2026-12-31")).toBe("2026-12-31");
    expect(nextSendDay("monthly", { ...anchors, invoiceSendDayOfMonth: 15 }, "2026-12-16")).toBe("2027-01-15");
    expect(isSendDay("monthly", anchors, "2028-02-29")).toBe(true);
  });

  test("immediate has no send day of its own", () => {
    expect(nextSendDay("immediate", anchors, "2026-11-23")).toBe("2026-11-23");
  });

  test("the deputy sees when a queued invoice goes out", () => {
    expect(queuedSendText("weekly", "2026-11-27")).toBe("Queued for the weekly send on Fri, Nov 27.");
    expect(queuedSendText("every_2_weeks", "2026-12-04")).toBe("Queued for the every-two-weeks send on Fri, Dec 4.");
    expect(queuedSendText("monthly", "2026-11-30")).toBe("Queued for the monthly send on Mon, Nov 30.");
  });
});
