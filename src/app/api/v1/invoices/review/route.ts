import { listInvoicesForReview } from "@/domain/invoices/review";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /invoices/review"], async ({ actor, run }) => run((tx) => listInvoicesForReview(actor, tx)));
