import { describe, expect, test } from "vitest";
import { BUILT_IN_REPORTS } from "@/domain/reports/saved";

describe("built-in reports", () => {
  test("unpaid invoices include those queued to send and those approved without sending", () => {
    const r = BUILT_IN_REPORTS.find((x) => x.name === "Unpaid invoices by responsible party and age")!;
    expect(r.spec.filters.statuses).toEqual(["pending_review", "ready_to_send", "approved_unsent", "sent"]);
  });

  test("personnel activity is built in, one row per person", () => {
    const r = BUILT_IN_REPORTS.find((x) => x.name === "Personnel activity")!;
    expect(r.spec).toMatchObject({ dataset: "activity", groupBy: ["deputy"] });
    expect(r.spec.measures).toContain("cancellation_rate");
  });
});
