import { placePaymentHold, resolvePaymentHold } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /vendors/{id}/payment-hold"], async ({ actor, params, body, run }) => run((tx) => placePaymentHold(actor, tx, params.id, body.reason)));

export const DELETE = apiHandler(routes["DELETE /vendors/{id}/payment-hold"], async ({ actor, params, body, run }) => run((tx) => resolvePaymentHold(actor, tx, params.id, body)));
