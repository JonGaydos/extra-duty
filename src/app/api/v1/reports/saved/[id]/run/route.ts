import { runSavedReport } from "@/domain/reports/saved";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** A date-only from is the start of that agency day and a date-only to its end. */
export const POST = apiHandler(routes["POST /reports/saved/{id}/run"], async ({ actor, params, body, run }) => run((tx) => runSavedReport(actor, tx, params.id, { from: body?.from, to: body?.to })));
