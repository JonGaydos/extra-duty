import { apiHandler } from "@/lib/api/handler";
import { openApiDocument } from "@/lib/api/openapi";
import { routes } from "@/lib/api/registry";

/** The OpenAPI 3.1 document for /api/v1, built from the route registry. Public, so tools can read it. apiHandler takes a promise. */
export const GET = apiHandler(routes["GET /openapi.json"], () => Promise.resolve(Response.json(openApiDocument(), { headers: { "cache-control": "no-store" } })));
