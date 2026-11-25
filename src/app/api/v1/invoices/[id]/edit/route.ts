import { editInvoice } from "@/domain/invoices/review";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseEditBody } from "../../parse";

export const POST = apiHandler(routes["POST /invoices/{id}/edit"], async ({ actor, params, body, run }) => run((tx) => editInvoice(actor, tx, params.id, parseEditBody(body))));
