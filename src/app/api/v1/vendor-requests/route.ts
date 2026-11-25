import { assertCan } from "@/domain/auth/policy";
import { ValidationError } from "@/domain/errors";
import { MAX_FILE_BYTES } from "@/domain/files/files";
import { resolveSafetyPins } from "@/domain/jobs/safety";
import { submitRequest } from "@/domain/vendor-portal/requests";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { UPLOAD_ENVELOPE, limitedFormData } from "../files";
import { parseVendorRequest } from "./parse";

/**
 * A vendor's detail request as multipart form data: `request` (the JSON wire) and an optional `contractFile`.
 * A route rather than a server action, so a contract file may be up to the usual 20 MB; a larger body is refused
 * with 413 before it is read into memory. The caller's role is checked before anything is read or looked up, then
 * safety addresses are looked up before the transaction opens.
 */
export const POST = apiHandler(routes["POST /vendor-requests"], async ({ actor, req, run }) => {
  assertCan(actor, "vendorRequest.submit", { vendorId: actor.vendorId ?? undefined });
  const form = await limitedFormData(req, MAX_FILE_BYTES + UPLOAD_ENVELOPE, "The upload is too large. A contract file can be at most 20 MB.");
  const raw = form?.get("request");
  let wire: unknown;
  try {
    wire = typeof raw === "string" ? JSON.parse(raw) : undefined;
  } catch {
    wire = undefined;
  }
  const upload = form?.get("contractFile");
  const file = upload instanceof File && upload.size > 0 ? { body: Buffer.from(await upload.arrayBuffer()), filename: upload.name, contentType: upload.type } : undefined;
  let input = parseVendorRequest(wire, file);
  if (input.safety) input = { ...input, safety: await resolveSafetyPins(input.safety) };
  const created = await run((tx) => submitRequest(actor, tx, input));
  if (created.length === 0) throw new ValidationError("Choose at least one date.");
  return { id: created[0].id, count: created.length };
});
