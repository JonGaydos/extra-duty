import { listSent } from "@/domain/messages/messages";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /messages/sent"], async ({ actor, query, run }) => run((tx) => listSent(actor, tx, { page: query.page ?? 1 })));
