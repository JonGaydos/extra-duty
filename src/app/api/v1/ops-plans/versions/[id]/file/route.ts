import { readOpsPlanVersion } from "@/domain/ops-plans/ops-plans";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { attachment } from "../../../../files";

/** One ops plan version's file. Personnel, coordinators and admins; never vendors (the service decides). */
export const GET = apiHandler(routes["GET /ops-plans/versions/{id}/file"], async ({ actor, params, run }) => {
  const { row, body } = await run((tx) => readOpsPlanVersion(actor, tx, params.id));
  return attachment(body, row.contentType, row.filename);
});
