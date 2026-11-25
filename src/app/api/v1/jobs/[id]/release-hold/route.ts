import { releaseHold } from "@/domain/jobs/jobs";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /jobs/{id}/release-hold"], async ({ actor, params, run }) => run((tx) => releaseHold(actor, tx, params.id)));
