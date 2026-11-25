import { getWorkSchedule, setWorkSchedule } from "@/domain/planning/schedule";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /me/work-schedule"], async ({ actor, run }) => run((tx) => getWorkSchedule(actor, tx, actor.userId)));

/** Body is the schedule, or null to turn it off. */
export const PUT = apiHandler(routes["PUT /me/work-schedule"], async ({ actor, body, run }) => run((tx) => setWorkSchedule(actor, tx, body)));
