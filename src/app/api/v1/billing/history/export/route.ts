import { exportBillingCsv } from "@/domain/billing/history";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** A date-only from and to are agency days (start and end). */
export const GET = apiHandler(routes["GET /billing/history/export"], async ({ actor, query, run }) => {
  const csv = await run((tx) => exportBillingCsv(actor, tx, { from: query.from, to: query.to, vendorId: query.vendorId, payeeUserId: query.payeeUserId }));
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="billing-history.csv"',
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
});
