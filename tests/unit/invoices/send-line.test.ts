import { describe, expect, test } from "vitest";
import { DEFAULT_SETTINGS } from "@/domain/settings/defaults";
import { approveLine, sendLine, type SendLineInvoice } from "@/domain/invoices/send-line";

// Thursday, Dec 3, 2026, noon in the agency's time zone. Weekly sends go on Fridays (the default day 5).
const NOW = new Date("2026-12-03T18:00:00Z");
const s = { ...DEFAULT_SETTINGS, invoiceSendDayOfWeek: 5 };
const inv = (o: Partial<SendLineInvoice> = {}): SendLineInvoice => ({
  status: "sent",
  sentAt: NOW,
  readyAt: null,
  paidSendQueued: false,
  batched: false,
  sentByPayee: true,
  vendorName: "Harborview Bank",
  vendorSchedule: null,
  sendByDefault: true,
  ...o,
});

describe("how and when an invoice goes to the vendor (staff only)", () => {
  test("billed and sent at once on an immediate schedule", () => {
    expect(sendLine(inv(), { ...s, invoiceSendSchedule: "immediate" }, NOW)).toBe("Sent right away when billed (Harborview Bank sends immediately)");
  });

  test("sent when a coordinator approved it", () => {
    expect(sendLine(inv({ sentByPayee: false }), s, NOW)).toBe("Sent when approved on Thu, Dec 3 (Harborview Bank sends immediately)");
  });

  test("sent in a batch", () => {
    expect(sendLine(inv({ batched: true, vendorSchedule: "weekly" }), s, NOW)).toBe("Sent with the weekly send on Thu, Dec 3");
  });

  test("queued for the vendor's weekly send", () => {
    expect(sendLine(inv({ status: "ready_to_send", sentAt: null, readyAt: NOW, vendorSchedule: "weekly" }), s, NOW)).toBe("Waiting for the weekly send on Fri, Dec 4");
  });

  test("queued on the agency's monthly schedule", () => {
    const monthly = { ...s, invoiceSendSchedule: "monthly" as const, invoiceSendDayOfMonth: 15 };
    expect(sendLine(inv({ status: "ready_to_send", sentAt: null, readyAt: NOW }), monthly, NOW)).toBe("Waiting for the monthly send on Tue, Dec 15 (agency default)");
  });

  test("approved, not sent", () => {
    expect(sendLine(inv({ status: "approved_unsent", sentAt: null }), s, NOW)).toBe("Approved, not sent: send it from here when ready");
    expect(sendLine(inv({ status: "approved_unsent", sentAt: null, sendByDefault: false }), s, NOW)).toBe(
      "Approved, not sent: send it from here when ready (Harborview Bank does not get approved invoices by email)",
    );
  });

  test("waiting for review, by the agency's review setting", () => {
    expect(sendLine(inv({ status: "pending_review", sentAt: null }), { ...s, invoiceReviewMode: "all" }, NOW)).toBe("Waiting for review (agency reviews every invoice)");
    expect(sendLine(inv({ status: "pending_review", sentAt: null }), { ...s, invoiceReviewMode: "changed_hours_only" }, NOW)).toBe("Waiting for review (the billed hours were changed)");
    expect(sendLine(inv({ status: "pending_review", sentAt: null }), { ...s, invoiceReviewMode: "immediate" }, NOW)).toBe("Waiting for review");
  });

  test("sent back, and closed without being sent", () => {
    expect(sendLine(inv({ status: "returned", sentAt: null }), s, NOW)).toBe("Sent back to the deputy: it goes again when they bill it");
    expect(sendLine(inv({ status: "paid", sentAt: null }), s, NOW)).toBe("Closed as paid without being sent to the vendor");
    expect(sendLine(inv({ status: "paid", sentAt: null, readyAt: NOW, paidSendQueued: true, vendorSchedule: "weekly" }), s, NOW)).toBe(
      "Paid; goes marked Paid with the weekly send on Fri, Dec 4",
    );
  });

  test("what approving will do", () => {
    expect(approveLine(inv({ status: "pending_review" }), { ...s, invoiceSendSchedule: "immediate" }, NOW)).toBe("Approve and send: goes to Harborview Bank now.");
    expect(approveLine(inv({ status: "pending_review", vendorSchedule: "weekly" }), s, NOW)).toBe("Approve for the next send: the weekly send on Fri, Dec 4.");
  });
});
