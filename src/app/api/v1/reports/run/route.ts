import { runReport, type ReportSpec } from "@/domain/reports/engine";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** The spec is validated (Zod) inside runReport; date-only from and to are agency days. */
export const POST = apiHandler(routes["POST /reports/run"], async ({ actor, body, run }) => run((tx) => runReport(actor, tx, body.spec as ReportSpec)));
