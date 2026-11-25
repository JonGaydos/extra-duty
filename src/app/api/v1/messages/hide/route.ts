import { hideMessages } from "@/domain/messages/messages";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /messages/hide"], async ({ actor, body, run }) => {
  await run((tx) => hideMessages(actor, tx, body.ids));
  return { ok: true };
});
