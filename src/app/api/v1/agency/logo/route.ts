import { MAX_LOGO_BYTES, readAgencyLogo, setAgencyLogo } from "@/domain/settings/logo";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { UPLOAD_ENVELOPE, limitedFormData } from "../../files";

export const dynamic = "force-dynamic";


/**
 * The agency logo, public so sign-in and printed pages can show it. Serves only the file the settings name as
 * the logo (always a PNG), never any other stored file.
 */
export const GET = apiHandler(routes["GET /agency/logo"], async ({ run }) => {
  const logo = await run((tx) => readAgencyLogo(tx));
  if (!logo) throw new NotFoundError("No logo is set.");
  return new Response(new Uint8Array(logo.body), {
    headers: {
      "Content-Type": "image/png",
      "Cache-Control": "public, max-age=300",
      "X-Content-Type-Options": "nosniff",
      ETag: `"${logo.id}"`,
    },
  });
});

/**
 * Coordinators and admins upload a new logo as multipart form data (field `logo`). A route rather than a server
 * action, so server actions keep Next's default 1 MB body limit while a logo may be up to 2 MB.
 */
export const POST = apiHandler(routes["POST /agency/logo"], async ({ actor, req, run }) => {
  const form = await limitedFormData(req, MAX_LOGO_BYTES + UPLOAD_ENVELOPE, "The logo can be at most 2 MB.");
  const file = form?.get("logo");
  if (!(file instanceof File) || file.size === 0) throw new ValidationError("Choose a PNG, SVG, JPG or WebP file.");
  const body = Buffer.from(await file.arrayBuffer());
  await run((tx) => setAgencyLogo(actor, tx, { filename: file.name, body }));
  return { message: "Logo saved. Invoices use it from now on." };
});
