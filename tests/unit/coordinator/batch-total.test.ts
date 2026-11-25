import { expect, test } from "vitest";
import { totalDue } from "@/app/(app)/coordinate/send-invoices/batch-total";

test("a paid invoice in a batch adds nothing to the total due", () => {
  expect(totalDue([{ totalCents: 26000, paid: false }, { totalCents: 29250, paid: true }])).toBe(26000);
  expect(totalDue([{ totalCents: 29250, paid: true }])).toBe(0);
  expect(totalDue([])).toBe(0);
});
