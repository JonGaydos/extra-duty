import { messageCoordinators } from "@/domain/messages/messages";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /messages/coordinators"], async ({ actor, body, run }) => run((tx) => messageCoordinators(actor, tx, body)));
