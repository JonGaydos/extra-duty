import type { ReportSpec } from "@/domain/reports/engine";
import { listSavedReports, saveReport } from "@/domain/reports/saved";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /reports/saved"], async ({ actor, run }) => run((tx) => listSavedReports(actor, tx)));

export const POST = apiHandler(routes["POST /reports/saved"], async ({ actor, body, run }) => run((tx) => saveReport(actor, tx, body.name, body.spec as ReportSpec)));
