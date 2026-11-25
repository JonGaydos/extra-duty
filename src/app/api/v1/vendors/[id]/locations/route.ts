import { addLocation, listLocations } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /vendors/{id}/locations"], async ({ actor, params, query, run }) =>
  run((tx) => listLocations(actor, tx, params.id, { includeInactive: query.includeInactive === true })),
);

export const POST = apiHandler(routes["POST /vendors/{id}/locations"], async ({ actor, params, body, run }) => run((tx) => addLocation(actor, tx, params.id, body)));
