import { deleteSavedReport } from "@/domain/reports/saved";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const DELETE = apiHandler(routes["DELETE /reports/saved/{id}"], async ({ actor, params, run }) => {
  await run((tx) => deleteSavedReport(actor, tx, params.id));
  return { id: params.id };
});
