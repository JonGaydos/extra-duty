import { listCalendarBusy } from "@/domain/planning/calendar";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /me/calendar-busy"], async ({ actor, run }) => run((tx) => listCalendarBusy(actor, tx, actor.userId)));
