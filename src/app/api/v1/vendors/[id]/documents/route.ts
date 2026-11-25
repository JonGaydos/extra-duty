import { ValidationError } from "@/domain/errors";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import { agencyDateOnly } from "@/domain/time/agency-time";
import { addVendorDocument, listVendorDocuments } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { UPLOAD_ENVELOPE, limitedFormData } from "../../../files";

export const GET = apiHandler(routes["GET /vendors/{id}/documents"], async ({ actor, params, run }) => run((tx) => listVendorDocuments(actor, tx, params.id)));

function field(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" && v !== "" ? v : undefined;
}

/** A YYYY-MM-DD field as that agency day (midnight in America/Chicago). */
function day(form: FormData, name: string): Date | undefined {
  const v = field(form, name);
  if (v === undefined) return undefined;
  const d = agencyDateOnly(v);
  if (!d) throw new ValidationError("A date is not valid.");
  return d;
}

/** Multipart form: kind, label, optional signedOn/expiresOn (YYYY-MM-DD agency days), and either file or url. */
export const POST = apiHandler(routes["POST /vendors/{id}/documents"], async ({ actor, params, req, run }) => {
  const form = await limitedFormData(req, MAX_FILE_BYTES + UPLOAD_ENVELOPE, "The upload is too large. Files can be at most 20 MB.");
  if (!form) throw new ValidationError("Send the document as a form upload.");
  const upload = form.get("file");
  const file = upload instanceof File ? upload : undefined;
  return run(async (tx) =>
    addVendorDocument(actor, tx, params.id, {
      kind: field(form, "kind") as "contract" | "other",
      label: field(form, "label") ?? "",
      file: file ? Buffer.from(await file.arrayBuffer()) : undefined,
      filename: file?.name,
      contentType: file?.type,
      url: field(form, "url"),
      signedOn: day(form, "signedOn"),
      expiresOn: day(form, "expiresOn"),
    }),
  );
});
