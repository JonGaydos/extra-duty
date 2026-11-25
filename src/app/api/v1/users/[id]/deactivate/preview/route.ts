import { departureChecklist } from "@/domain/users/users";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** The checklist shown before someone is turned off. Changes nothing. */
export const GET = apiHandler(routes["GET /users/{id}/deactivate/preview"], async ({ actor, params, query, run }) => run((tx) => departureChecklist(actor, tx, params.id, query.lastDay)));
