import { earningsDashboard } from "@/domain/reports/earnings";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /reports/earnings"], async ({ actor, query, run }) => run((tx) => earningsDashboard(actor, tx, query.userId ?? actor.userId)));
