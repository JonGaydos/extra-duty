import { calendarFeedFor } from "@/domain/planning/ics-feed";
import { NotFoundError } from "@/domain/errors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** The personal calendar feed. The token in the link is the only credential; an unknown or revoked one is 404. */
export const GET = apiHandler(routes["GET /calendar.ics"], async ({ query, run }) => {
  const ics = await run((tx) => calendarFeedFor(tx, query.token ?? ""));
  if (ics === null) throw new NotFoundError();
  return new Response(ics, {
    headers: {
      "content-type": "text/calendar; charset=utf-8",
      "content-disposition": 'inline; filename="extra-duty.ics"',
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
    },
  });
});
