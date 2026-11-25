import { createJob, listJobs, type JobInput } from "@/domain/jobs/jobs";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { parseDirection, parseWindow, parseJobBody, parseSort, parseStates } from "./parse";

/** A date-only from and to are agency days (from its midnight, to its end). */
export const GET = apiHandler(routes["GET /jobs"], async ({ actor, query, run }) => {
  // "Only details I can work" needs a bounded range: default to the next 90 days.
  const onlyWorkable = query.onlyWorkable === true;
  const window = parseWindow(query.from, query.to, onlyWorkable, Date.now());
  const filter = {
    ...window,
    status: parseStates(query.status),
    typeIds: query.typeIds,
    vendorIds: query.vendorIds,
    text: query.text,
    mine: query.mine === true,
    onlyWorkable,
    sort: parseSort(query.sort ?? null),
    direction: parseDirection(query.direction ?? null),
  };
  return run((tx) => listJobs(actor, tx, filter, query.page ?? 1));
});

export const POST = apiHandler(routes["POST /jobs"], async ({ actor, body, run }) => {
  const input = (await parseJobBody(actor, "job.create", body as Parameters<typeof parseJobBody>[2])) as JobInput;
  return run((tx) => createJob(actor, tx, input));
});
