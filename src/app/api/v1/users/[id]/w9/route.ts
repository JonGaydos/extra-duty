import { ValidationError } from "@/domain/errors";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import { readW9, uploadW9For } from "@/domain/w9/w9";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { UPLOAD_ENVELOPE, attachment, limitedFormData } from "../../../files";

const TOO_LARGE = "The file is too large. Use a PDF under 20 MB.";

/** A person's current W-9: the owner, coordinators and admins (audited). API keys need the w9 scope. */
export const GET = apiHandler(routes["GET /users/{id}/w9"], async ({ actor, params, run }) => {
  const w9 = await run((tx) => readW9(actor, tx, params.id));
  return attachment(w9.body, "application/pdf", w9.filename);
});

/** Staff upload a W-9 for the person (a PDF in the `file` field). It becomes their latest, pending review. */
export const POST = apiHandler(routes["POST /users/{id}/w9"], async ({ actor, params, req, run }) => {
  const form = await limitedFormData(req, MAX_FILE_BYTES + UPLOAD_ENVELOPE, TOO_LARGE);
  if (!form) throw new ValidationError("Send the W-9 as a file upload.");
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("Choose a PDF of the W-9.");
  if (file.size > MAX_FILE_BYTES) throw new ValidationError(TOO_LARGE);
  const row = await run(async (tx) => uploadW9For(actor, tx, params.id, Buffer.from(await file.arrayBuffer())));
  return { id: row.id, status: row.status, uploadedAt: row.uploadedAt };
});
