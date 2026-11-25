import { sendApprovedInvoice } from "@/domain/invoices/review";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /invoices/{id}/send"], async ({ actor, params, run }) => run((tx) => sendApprovedInvoice(actor, tx, params.id)));
