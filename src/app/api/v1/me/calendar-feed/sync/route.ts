import { syncCalendarNow } from "@/domain/planning/calendar";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /me/calendar-feed/sync"], async ({ actor, run }) => syncCalendarNow(actor, run));
