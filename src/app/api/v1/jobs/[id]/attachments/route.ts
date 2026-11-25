import { ValidationError } from "@/domain/errors";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import { attachContractToJob } from "@/domain/jobs/attachments";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { UPLOAD_ENVELOPE, limitedFormData } from "../../../files";

/** Multipart form: label, and either file or url. Attaches a contract to this one detail. */
export const POST = apiHandler(routes["POST /jobs/{id}/attachments"], async ({ actor, params, req, run }) => {
  const form = await limitedFormData(req, MAX_FILE_BYTES + UPLOAD_ENVELOPE, "The upload is too large. Files can be at most 20 MB.");
  if (!form) throw new ValidationError("Send the contract as a form upload.");
  const label = form.get("label");
  const url = form.get("url");
  const upload = form.get("file");
  const file = upload instanceof File && upload.size > 0 ? { body: Buffer.from(await upload.arrayBuffer()), filename: upload.name, contentType: upload.type } : undefined;
  return run((tx) => attachContractToJob(actor, tx, params.id, { label: typeof label === "string" ? label : "", url: typeof url === "string" && url !== "" ? url : undefined, file }));
});
