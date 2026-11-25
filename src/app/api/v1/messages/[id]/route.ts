import { getMessage } from "@/domain/messages/messages";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /messages/{id}"], async ({ actor, params, run }) => run((tx) => getMessage(actor, tx, params.id)));
