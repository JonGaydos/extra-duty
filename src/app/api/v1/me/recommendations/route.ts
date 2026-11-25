import { recommendationsFor } from "@/domain/planning/recommend";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /me/recommendations"], async ({ actor, run }) => run((tx) => recommendationsFor(actor, tx, new Date())));
