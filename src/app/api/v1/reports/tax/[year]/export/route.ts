import { exportTaxSummary } from "@/domain/reports/tax";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { download, parseYear } from "../../../parse";

export const GET = apiHandler(routes["GET /reports/tax/{year}/export"], async ({ actor, params, query, run }) => {
  const year = parseYear(params.year);
  const file = await run((tx) => exportTaxSummary(actor, tx, query.userId ?? actor.userId, year, query.format));
  return download(file, query.format, `payment-summary-${year}`);
});
