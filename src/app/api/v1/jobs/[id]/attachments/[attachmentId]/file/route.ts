import { readJobAttachmentFile } from "@/domain/jobs/attachments";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { attachment } from "../../../../../files";

/** A detail's attachment: staff and the detail's vendor; personnel only for attachments that are not contracts. */
export const GET = apiHandler(routes["GET /jobs/{id}/attachments/{attachmentId}/file"], async ({ actor, params, run }) => {
  const { row, body } = await run((tx) => readJobAttachmentFile(actor, tx, params.id, params.attachmentId));
  return attachment(body, row.contentType, row.filename);
});
