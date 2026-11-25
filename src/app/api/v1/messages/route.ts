import { listInbox, sendMessage } from "@/domain/messages/messages";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /messages"], async ({ actor, query, run }) =>
  run((tx) => listInbox(actor, tx, { text: query.text, unreadOnly: query.unreadOnly === true, page: query.page ?? 1 })),
);

export const POST = apiHandler(routes["POST /messages"], async ({ actor, body, run }) => run((tx) => sendMessage(actor, tx, body)));
