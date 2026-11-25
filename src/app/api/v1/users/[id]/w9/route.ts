import { readW9 } from "@/domain/w9/w9";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { attachment } from "../../../files";

/** A person's current W-9: the owner, coordinators and admins (audited). API keys need the w9 scope. */
export const GET = apiHandler(routes["GET /users/{id}/w9"], async ({ actor, params, run }) => {
  const w9 = await run((tx) => readW9(actor, tx, params.id));
  return attachment(w9.body, "application/pdf", w9.filename);
});
