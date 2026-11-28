import { describe, expect, it } from "vitest";
import { billingBanner, needsAttention } from "@/domain/billing/banner";

describe("the billing action banner", () => {
  it("is absent when nothing needs action", () => {
    expect(billingBanner({ unbilled: 0, attention: 0, locked: false })).toBeNull();
  });

  it("counts worked details to bill and opens To bill", () => {
    expect(billingBanner({ unbilled: 2, attention: 0, locked: false })).toEqual({
      tone: "warning",
      title: "You have 2 worked details to bill.",
      detail: "Billing them keeps your sign-ups open.",
      action: { href: "/billing?tab=bill", label: "Go to billing" },
    });
  });

  it("counts invoices that need the person and opens Waiting filtered to them", () => {
    const b = billingBanner({ unbilled: 0, attention: 1, locked: false });
    expect(b?.title).toBe("1 invoice needs your attention.");
    expect(b?.action.href).toBe("/billing?tab=waiting&needs=1");
  });

  it("says both, and says plainly when the lock is already active", () => {
    const b = billingBanner({ unbilled: 1, attention: 2, locked: true });
    expect(b?.title).toBe("You have 1 worked detail to bill. 2 invoices need your attention.");
    expect(b?.detail).toBe("Sign-ups are locked until you bill these.");
    expect(b?.tone).toBe("danger");
    expect(billingBanner({ unbilled: 0, attention: 1, locked: true })?.detail).toBe("Sign-ups are locked until you confirm these payments.");
  });

  it("an invoice needs the person when the vendor reported paying (their turn) or it was sent back", () => {
    expect(needsAttention({ status: "sent", turn: "deputy", deputyPaidAt: null })).toBe(true);
    expect(needsAttention({ status: "returned", turn: null, deputyPaidAt: null })).toBe(true);
    expect(needsAttention({ status: "sent", turn: "vendor", deputyPaidAt: null })).toBe(false);
    expect(needsAttention({ status: "paid", turn: null, deputyPaidAt: new Date() })).toBe(false);
  });
});
