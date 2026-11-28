import { NotFoundError } from "@/domain/errors";
import { parseDetailNumber, visibleJobIdByNumber } from "@/domain/jobs/detail-number";
import { openJob, updateJob } from "@/domain/jobs/jobs";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseJobBody } from "../parse";

/**
 * `{id}` is the detail's id, or its number (`9`): a number the caller may not see is not found, like a missing one.
 * Opening a confidential detail is logged, as in the app.
 */
export const GET = apiHandler(routes["GET /jobs/{id}"], async ({ actor, params, run }) =>
  run(async (tx) => {
    const n = parseDetailNumber(params.id);
    const id = n === null ? params.id : await visibleJobIdByNumber(actor, tx, n);
    if (!id) throw new NotFoundError("Job not found.");
    return openJob(actor, tx, id);
  }),
);

/** Body is job fields; `?scope=series` applies it to this and later jobs in the series. */
export const PATCH = apiHandler(routes["PATCH /jobs/{id}"], async ({ actor, params, query, body, run }) => {
  const patch = await parseJobBody(actor, "job.update", body as Parameters<typeof parseJobBody>[2]);
  return run((tx) => updateJob(actor, tx, params.id, patch, query.scope === "series" ? "series" : "one"));
});
