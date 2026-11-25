import { invoiceTimeline } from "@/domain/billing/payments";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /billing/invoices/{id}/timeline"], async ({ actor, params, run }) => run((tx) => invoiceTimeline(actor, tx, params.id)));
