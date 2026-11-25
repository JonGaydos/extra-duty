import { markRead } from "@/domain/messages/messages";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /messages/read"], async ({ actor, body, run }) => {
  await run((tx) => markRead(actor, tx, body.ids, body.read !== false));
  return { ok: true };
});
