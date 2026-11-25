import { taxYearSummary } from "@/domain/reports/tax";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseYear } from "../../parse";

export const GET = apiHandler(routes["GET /reports/tax/{year}"], async ({ actor, params, query, run }) => run((tx) => taxYearSummary(actor, tx, query.userId ?? actor.userId, parseYear(params.year))));
