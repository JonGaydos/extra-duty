import { pendingAcknowledgements } from "@/domain/messages/acknowledgements";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /messages/pending-acknowledgements"], async ({ actor, run }) => run((tx) => pendingAcknowledgements(actor, tx)));
