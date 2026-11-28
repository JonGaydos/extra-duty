import { acknowledgeMessage } from "@/domain/messages/acknowledgements";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /messages/{id}/acknowledge"], async ({ actor, params, run }) => run((tx) => acknowledgeMessage(actor, tx, params.id)));
