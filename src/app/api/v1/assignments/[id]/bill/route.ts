import { billAssignment } from "@/domain/billing/bill";
import { parseDate } from "@/app/api/v1/jobs/parse";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /assignments/{id}/bill"], async ({ actor, params, body, run }) =>
  run((tx) =>
    billAssignment(actor, tx, params.id, {
      startAt: parseDate(body.startAt, "Start"),
      endAt: parseDate(body.endAt, "End"),
      changeReason: body.changeReason,
      attachW9: body.attachW9 === true,
      paidOnSpot: body.paidOnSpot,
    }),
  ),
);
