import { beforeAll, describe, expect, test } from "vitest";
import { useTestDb } from "../../setup/test-db";
import { paymentMethods } from "@/db/schema";
import { markPaid } from "@/domain/billing/payments";
import { runReport, type ReportSpec } from "@/domain/reports/engine";
import { at, buildFixture, NOW } from "./helpers";

const spec = (o: Partial<ReportSpec>): ReportSpec => ({ dataset: "invoices", from: at(2026, 1, 1, 0), to: at(2027, 12, 31, 23), filters: {}, groupBy: [], measures: ["count"], ...o });

/** Owner decision 2026-11-26: paid means the deputy confirmed it; the vendor's own mark is not needed. */
describe("reports after the deputy's confirmation closes an invoice", () => {
  const get = useTestDb();
  let fx: Awaited<ReturnType<typeof buildFixture>>;
  beforeAll(async () => {
    fx = await buildFixture(get().db, "dcf");
  });
  const run = (s: ReportSpec) => get().db.transaction((tx) => runReport(fx.coord, tx, s, NOW));

  test("a deputy-confirmed invoice moves from outstanding to paid and leaves the open-by-turn view", async () => {
    const before = await run(spec({ measures: ["billed_cents", "paid_cents", "outstanding_cents"] }));
    const open = { statuses: ["pending_review", "ready_to_send", "approved_unsent", "sent"] as ReportSpec["filters"]["statuses"] };
    const openBefore = await run(spec({ filters: open, measures: ["count", "outstanding_cents"] }));
    const [{ id: method }] = await get().db.select({ id: paymentMethods.id }).from(paymentMethods).limit(1);
    // B: 42000, sent, the vendor never marked it.
    await get().db.transaction((tx) => markPaid(fx.deputy, tx, fx.inv.B.id, { paymentMethodId: method, reference: "", paidAt: at(2027, 1, 18) }, NOW));
    const after = await run(spec({ measures: ["billed_cents", "paid_cents", "outstanding_cents"] }));
    expect(after.totals.billed_cents).toBe(before.totals.billed_cents);
    expect(after.totals.paid_cents).toBe(Number(before.totals.paid_cents) + 42000);
    expect(after.totals.outstanding_cents).toBe(Number(before.totals.outstanding_cents) - 42000);
    const openAfter = await run(spec({ filters: open, measures: ["count", "outstanding_cents"] }));
    expect(openAfter.totals.count).toBe(Number(openBefore.totals.count) - 1);
    expect(openAfter.totals.outstanding_cents).toBe(Number(openBefore.totals.outstanding_cents) - 42000);
  });
});
