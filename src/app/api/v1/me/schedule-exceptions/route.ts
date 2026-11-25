import { addScheduleException, listScheduleExceptions } from "@/domain/planning/schedule";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /me/schedule-exceptions"], async ({ actor, run }) => run((tx) => listScheduleExceptions(actor, tx, actor.userId)));

/** `date` is an agency date (YYYY-MM-DD). */
export const POST = apiHandler(routes["POST /me/schedule-exceptions"], async ({ actor, body, run }) => run((tx) => addScheduleException(actor, tx, body)));
