import { coordinatorCloseInvoice } from "@/domain/billing/payments";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseCloseBody } from "../../../parse";

export const POST = apiHandler(routes["POST /billing/invoices/{id}/close"], async ({ actor, params, body, run }) =>
  run((tx) => coordinatorCloseInvoice(actor, tx, params.id, parseCloseBody(body))),
);
