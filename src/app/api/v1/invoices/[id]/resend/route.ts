import { resendInvoice } from "@/domain/invoices/review";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /invoices/{id}/resend"], async ({ actor, params, body, run }) => run((tx) => resendInvoice(actor, tx, params.id, { alsoTo: body?.alsoTo })));
