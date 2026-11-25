import { deputyNotesForJob, submitDeputyNote } from "@/domain/deputy-notes/deputy-notes";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** `?jobId=` lists the approved notes shown on that job. */
export const GET = apiHandler(routes["GET /deputy-notes"], async ({ actor, query, run }) => run((tx) => deputyNotesForJob(actor, tx, query.jobId)));

export const POST = apiHandler(routes["POST /deputy-notes"], async ({ actor, body, run }) => run((tx) => submitDeputyNote(actor, tx, body)));
