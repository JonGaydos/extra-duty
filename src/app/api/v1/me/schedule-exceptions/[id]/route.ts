import { removeScheduleException } from "@/domain/planning/schedule";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const DELETE = apiHandler(routes["DELETE /me/schedule-exceptions/{id}"], async ({ actor, params, run }) => {
  await run((tx) => removeScheduleException(actor, tx, params.id));
  return { ok: true };
});
