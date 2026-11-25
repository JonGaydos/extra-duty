import { sendBackInvoice } from "@/domain/invoices/review";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /invoices/{id}/send-back"], async ({ actor, params, body, run }) => run((tx) => sendBackInvoice(actor, tx, params.id, body?.comment)));
