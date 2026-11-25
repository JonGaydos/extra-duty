import { getJob, updateJob } from "@/domain/jobs/jobs";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseJobBody } from "../parse";

export const GET = apiHandler(routes["GET /jobs/{id}"], async ({ actor, params, run }) => run((tx) => getJob(actor, tx, params.id)));

/** Body is job fields; `?scope=series` applies it to this and later jobs in the series. */
export const PATCH = apiHandler(routes["PATCH /jobs/{id}"], async ({ actor, params, query, body, run }) => {
  const patch = await parseJobBody(actor, "job.update", body as Parameters<typeof parseJobBody>[2]);
  return run((tx) => updateJob(actor, tx, params.id, patch, query.scope === "series" ? "series" : "one"));
});
