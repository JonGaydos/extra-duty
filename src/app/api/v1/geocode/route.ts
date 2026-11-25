import { lookupAddress } from "@/domain/vendors/geocode";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const dynamic = "force-dynamic";

/**
 * `?q=<address>`: the OpenStreetMap match for the address field, for any signed-in person. Answers
 * `{ data: { status, match } }`; "unavailable" means the lookup failed, is busy or the person has used this
 * minute's lookups, and the field saves anyway. Every answer comes within about 7 seconds.
 */
export const GET = apiHandler(routes["GET /geocode"], async ({ actor, query }) => {
  const r = await lookupAddress((query.q ?? "").slice(0, 300), { user: actor.userId });
  return { status: r.status, match: r.status === "match" ? r.match : null };
});
