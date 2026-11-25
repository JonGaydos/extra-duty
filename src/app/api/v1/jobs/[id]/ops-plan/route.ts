import { ValidationError } from "@/domain/errors";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import { submitOpsPlan } from "@/domain/ops-plans/ops-plans";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { UPLOAD_ENVELOPE, limitedFormData } from "../../../files";

const TOO_LARGE = "The file is too large. Ops plans can be at most 20 MB.";

/** Multipart form with `file`: the Incident Commander submits the next version of the detail's ops plan. */
export const POST = apiHandler(routes["POST /jobs/{id}/ops-plan"], async ({ actor, params, req, run }) => {
  const form = await limitedFormData(req, MAX_FILE_BYTES + UPLOAD_ENVELOPE, TOO_LARGE);
  if (!form) throw new ValidationError("Send the ops plan as a file upload.");
  const upload = form.get("file");
  if (!(upload instanceof File) || upload.size === 0) throw new ValidationError("Choose the ops plan file.");
  if (upload.size > MAX_FILE_BYTES) throw new ValidationError(TOO_LARGE);
  const body = Buffer.from(await upload.arrayBuffer());
  return run((tx) => submitOpsPlan(actor, tx, params.id, { filename: upload.name, contentType: upload.type, body }));
});
