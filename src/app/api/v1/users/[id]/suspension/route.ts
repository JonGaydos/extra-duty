import { liftSuspension, suspendUser } from "@/domain/users/suspension";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** A date-only `until` is agency midnight of that day; null suspends with no end date. */
export const POST = apiHandler(routes["POST /users/{id}/suspension"], async ({ actor, params, body, run }) =>
  run((tx) => suspendUser(actor, tx, params.id, { reason: body.reason, until: body.until, removeFutureAssignments: body.removeFutureAssignments === true })),
);

export const DELETE = apiHandler(routes["DELETE /users/{id}/suspension"], async ({ actor, params, run }) => run((tx) => liftSuspension(actor, tx, params.id)));
