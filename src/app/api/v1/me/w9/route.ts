import { ValidationError } from "@/domain/errors";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import { readW9, uploadW9 } from "@/domain/w9/w9";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { UPLOAD_ENVELOPE, attachment, limitedFormData } from "../../files";

const TOO_LARGE = "The file is too large. Use a PDF under 20 MB.";

/** The caller's own W-9, as a download. API keys need the w9 scope. */
export const GET = apiHandler(routes["GET /me/w9"], async ({ actor, run }) => {
  const w9 = await run((tx) => readW9(actor, tx, actor.userId));
  return attachment(w9.body, "application/pdf", w9.filename);
});

/** Uploads the caller's W-9 (a PDF in the `file` field); it replaces the current one. Too large is refused early. */
export const POST = apiHandler(routes["POST /me/w9"], async ({ actor, req, run }) => {
  const form = await limitedFormData(req, MAX_FILE_BYTES + UPLOAD_ENVELOPE, TOO_LARGE);
  if (!form) throw new ValidationError("Send the W-9 as a file upload.");
  const file = form.get("file");
  if (!(file instanceof File)) throw new ValidationError("Choose a PDF of your W-9.");
  if (file.size > MAX_FILE_BYTES) throw new ValidationError(TOO_LARGE);
  const row = await run(async (tx) => uploadW9(actor, tx, Buffer.from(await file.arrayBuffer()), file.name));
  return { uploadedAt: row.uploadedAt };
});
