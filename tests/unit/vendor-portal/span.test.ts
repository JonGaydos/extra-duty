import { describe, expect, test } from "vitest";
import { spanFromInputs, spanInputs } from "@/app/(app)/vendor/_vendor/span";
import { invoiceSentence } from "@/app/(app)/_personnel/invoice-text";
import type { MyInvoice } from "@/domain/personnel/views";
import { agencyInstant } from "@/domain/time/agency-time";

describe("vendor detail times", () => {
  test("a date and two clock times become agency instants", () => {
    expect(spanFromInputs("2026-12-05", "18:00", "22:00")).toEqual({ startAt: agencyInstant(2026, 12, 5, 18, 0), endAt: agencyInstant(2026, 12, 5, 22, 0) });
  });

  test("an end at or before the start finishes the next day", () => {
    expect(spanFromInputs("2026-12-31", "22:00", "02:00")).toEqual({ startAt: agencyInstant(2026, 12, 31, 22, 0), endAt: agencyInstant(2027, 1, 1, 2, 0) });
  });

  test("missing or malformed values are null", () => {
    expect(spanFromInputs("", "18:00", "22:00")).toBeNull();
    expect(spanFromInputs("2026-02-30", "18:00", "22:00")).toBeNull();
    expect(spanFromInputs("2026-12-05", "6 PM", "22:00")).toBeNull();
    expect(spanFromInputs("2026-12-05", "25:00", "22:00")).toBeNull();
  });

  test("a saved span reads back as the form's date and clock times", () => {
    expect(spanInputs(agencyInstant(2026, 12, 31, 22, 0), agencyInstant(2027, 1, 1, 2, 30))).toEqual({ date: "2026-12-31", start: "22:00", end: "02:30" });
  });
});

describe("the deputy's invoice sentence", () => {
  test("a vendor's paid note uses the spec wording", () => {
    const inv = { status: "sent", openIssue: false, vendorPaidAt: agencyInstant(2026, 12, 3, 10, 0), vendorMethod: "Check mailed", vendorReference: "1042", dueAt: null, responseDays: null } as unknown as MyInvoice;
    expect(invoiceSentence(inv, new Date())[0]).toBe("Vendor reports paid on Dec 3 by Check mailed, #1042.");
  });
});
