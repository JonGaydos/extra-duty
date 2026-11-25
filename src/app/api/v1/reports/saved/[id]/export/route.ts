import { exportSavedReport } from "@/domain/reports/saved";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { download } from "../../../parse";

export const POST = apiHandler(routes["POST /reports/saved/{id}/export"], async ({ actor, params, body, run }) => {
  const file = await run((tx) => exportSavedReport(actor, tx, params.id, { from: body.from, to: body.to }, body.format));
  return download(file, body.format, "report");
});
