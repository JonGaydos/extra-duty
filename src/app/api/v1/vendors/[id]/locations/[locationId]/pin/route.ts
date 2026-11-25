import { setLocationPin } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const PUT = apiHandler(routes["PUT /vendors/{id}/locations/{locationId}/pin"], async ({ actor, params, body, run }) => run((tx) => setLocationPin(actor, tx, params.locationId, body)));
