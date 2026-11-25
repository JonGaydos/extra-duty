import { exportReport, type ReportSpec } from "@/domain/reports/engine";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { download, reportAccess } from "../parse";

/** Date-only from and to are agency days (the engine reads them with agencyDateOnly). A refusal comes back as JSON. */
export const POST = apiHandler(routes["POST /reports/export"], async ({ actor, body, run }) => {
  const file = await reportAccess(run((tx) => exportReport(actor, tx, body.spec as ReportSpec, body.format)));
  return download(file, body.format, "report");
});
