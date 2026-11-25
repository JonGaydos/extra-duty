import { describe, expect, test } from "vitest";
import { billMessage } from "@/app/(app)/_personnel/bill-message";

describe("billMessage", () => {
  test.each([
    ["sent_queued", "sent", "Invoice sent to the vendor."],
    ["held_for_review", "pending_review", "Invoice sent to a coordinator for review."],
    ["ready_to_send", "ready_to_send", "Invoice approved. It goes out with the vendor's next invoice send."],
    ["approved_unsent", "approved_unsent", "Invoice billed. It is not emailed to this vendor; a coordinator sends it if needed."],
    ["approved_unsent", "paid", "Invoice billed and closed as paid. It is not emailed to this vendor."],
    ["sent_queued", "paid", "Invoice billed and closed as paid. The vendor gets it marked Paid."],
    ["ready_to_send", "paid", "Invoice billed and closed as paid. It goes out marked Paid with the vendor's next invoice send."],
  ] as const)("%s (%s)", (delivery, status, text) => {
    expect(billMessage(delivery, status)).toBe(text);
  });
});
