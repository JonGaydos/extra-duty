import { readVendorDocumentFile } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { attachment } from "../../../../../files";

/** An uploaded vendor document: that vendor's users, coordinators and admins. Anyone else gets 404. */
export const GET = apiHandler(routes["GET /vendors/{id}/documents/{documentId}/file"], async ({ actor, params, run }) => {
  const { row, body } = await run((tx) => readVendorDocumentFile(actor, tx, params.id, params.documentId));
  return attachment(body, row.contentType, row.filename);
});
