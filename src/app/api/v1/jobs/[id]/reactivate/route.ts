import { reactivateJob } from "@/domain/jobs/jobs";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Body: `reason`, required. */
export const POST = apiHandler(routes["POST /jobs/{id}/reactivate"], async ({ actor, params, body, run }) => run((tx) => reactivateJob(actor, tx, params.id, body.reason)));
