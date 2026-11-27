import { getCalendarFeedStatus, saveCalendarLink } from "@/domain/planning/calendar";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Whether a link is set and the last fetch result; the link itself is never returned. */
export const GET = apiHandler(routes["GET /me/calendar-feed"], async ({ actor, run }) => run((tx) => getCalendarFeedStatus(actor, tx, actor.userId)));

/**
 * Body `{ url }`; null removes the link and its imported busy times. A new link is imported at once (the Sync now path
 * and its limit); the answer carries the result.
 */
export const PUT = apiHandler(routes["PUT /me/calendar-feed"], async ({ actor, body, run }) => {
  const r = await saveCalendarLink(actor, run, body.url);
  return { ok: true, ...r };
});
