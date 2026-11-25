import { cancelJob } from "@/domain/jobs/jobs";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/**
 * Body: `reason`, optional `cause` ("vendor_hold" cancels a locked detail, "vendor" a cancel for the vendor) and
 * `applyLateCancelPay` (pay signed-up people even when the hold came before the late window).
 */
export const POST = apiHandler(routes["POST /jobs/{id}/cancel"], async ({ actor, params, body, run }) =>
  run((tx) => cancelJob(actor, tx, params.id, body.reason, { cause: body.cause, applyLateCancelPay: body.applyLateCancelPay })),
);
