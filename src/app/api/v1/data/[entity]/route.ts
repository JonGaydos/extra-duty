import { readEntity } from "@/domain/export/export";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/**
 * One page of a table's rows: `?updatedSince=`, `?cursor=` (the last page's nextCursor), `?limit=` and equality
 * filters on any other column. Admins and API keys only; secret columns never leave.
 */
export const GET = apiHandler(routes["GET /data/{entity}"], async ({ actor, params, query, run }) => {
  const { updatedSince, cursor, limit, ...filters } = query;
  const { rows, nextCursor } = await run((tx) => readEntity(actor, tx, params.entity, { updatedSince, cursor, limit, filters: filters as Record<string, string> }));
  return Response.json({ data: rows, nextCursor }, { headers: { "cache-control": "no-store" } });
});
