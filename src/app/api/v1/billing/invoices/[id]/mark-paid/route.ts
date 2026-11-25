import { markPaid } from "@/domain/billing/payments";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** A date-only paid date is agency midnight. */
export const POST = apiHandler(routes["POST /billing/invoices/{id}/mark-paid"], async ({ actor, params, body, run }) =>
  run((tx) => markPaid(actor, tx, params.id, body)),
);
