import { signUp, eligibilityFor } from "@/domain/assignments/signup";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseDate } from "../../parse";

/** Signs the caller up. Without `jobPositionId` the first position they can take is used. */
export const POST = apiHandler(routes["POST /jobs/{id}/signup"], async ({ actor, params, body, run }) => {
  const plannedStartAt = body.plannedStartAt === undefined ? undefined : parseDate(body.plannedStartAt, "Planned start");
  const plannedEndAt = body.plannedEndAt === undefined ? undefined : parseDate(body.plannedEndAt, "Planned end");
  return run(async (tx) => {
    const jobPositionId = body.jobPositionId ?? (await eligibilityFor(actor, tx, params.id)).jobPositionId;
    return signUp(actor, tx, jobPositionId, { warningVersion: body.warningVersion, plannedStartAt, plannedEndAt, jobId: params.id });
  });
});
