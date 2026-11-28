import { remindUnacknowledged } from "@/domain/messages/acknowledgements";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /messages/{id}/acknowledgements/remind"], async ({ actor, params, run }) =>
  run(async (tx) => ({ reminded: await remindUnacknowledged(actor, tx, params.id) })),
);
