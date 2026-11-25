import { approveInvoice } from "@/domain/invoices/review";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /invoices/{id}/approve"], async ({ actor, params, body, run }) =>
  run((tx) => approveInvoice(actor, tx, params.id, new Date(), { send: body?.send, attachW9: body?.attachW9 })),
);
