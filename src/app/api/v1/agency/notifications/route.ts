import { agencyNotificationSettings, saveAgencyNotifications } from "@/domain/notifications/agency";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /agency/notifications"], async ({ actor, run }) => run((tx) => agencyNotificationSettings(actor, tx)));

export const PATCH = apiHandler(routes["PATCH /agency/notifications"], async ({ actor, body, run }) => ({
  channels: await run((tx) => saveAgencyNotifications(actor, tx, body.channels)),
}));
