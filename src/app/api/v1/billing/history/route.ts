import { billingHistory } from "@/domain/billing/history";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** A date-only from and to are agency days (start and end). */
export const GET = apiHandler(routes["GET /billing/history"], async ({ actor, query, run }) => run((tx) => billingHistory(actor, tx, { from: query.from, to: query.to, vendorId: query.vendorId, payeeUserId: query.payeeUserId })));
