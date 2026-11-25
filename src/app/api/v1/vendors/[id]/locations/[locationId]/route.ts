import { updateLocation } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const PATCH = apiHandler(routes["PATCH /vendors/{id}/locations/{locationId}"], async ({ actor, params, body, run }) => run((tx) => updateLocation(actor, tx, params.locationId, body)));
