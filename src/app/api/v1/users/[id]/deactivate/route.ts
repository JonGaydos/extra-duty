import { deactivateUser } from "@/domain/users/users";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Someone leaves: a reason and a last day (today or earlier). Returns the sign-ups removed and what is left to follow up. */
export const POST = apiHandler(routes["POST /users/{id}/deactivate"], async ({ actor, params, body, run }) =>
  run((tx) => deactivateUser(actor, tx, params.id, { reason: body.reason, lastDay: body.lastDay })),
);
