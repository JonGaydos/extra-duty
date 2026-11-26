import { DomainError } from "@/domain/errors";

/**
 * A file download: always an attachment (never rendered in the app's origin), with `nosniff` so a browser
 * cannot guess a different type, and not cached.
 */
export function attachment(body: Buffer, contentType: string, filename: string): Response {
  const safe = filename.replace(/[^\w.\- ]+/g, "_").slice(0, 120) || "download";
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": contentType,
      "content-disposition": `attachment; filename="${safe}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/** A request body over an upload limit. File routes answer it with 413. */
export class TooLargeError extends DomainError {
  constructor(message = "The upload is too large. Files can be at most 20 MB.") {
    super("too_large", message);
  }
}

/** Room for the multipart envelope around an uploaded file. */
export const UPLOAD_ENVELOPE = 64 * 1024;

/** Reads the body, stopping as soon as it passes `limit` bytes. */
async function readLimited(req: Request, limit: number, message?: string): Promise<Uint8Array<ArrayBuffer>> {
  if (!req.body) return new Uint8Array(new ArrayBuffer(0));
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  // Sequential: each chunk is read after the last, so the size is checked as the body streams in.
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new TooLargeError(message);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(new ArrayBuffer(total));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

/**
 * A multipart upload read without ever holding more than `limit` bytes: a missing or larger declared size is
 * refused before the body is touched, and a body that runs past its declared size stops at the limit. Null when
 * the body is not form data.
 */
export async function limitedFormData(req: Request, limit: number, message?: string): Promise<FormData | null> {
  const declared = req.headers.get("content-length");
  if (declared === null || !/^\d+$/.test(declared) || Number(declared) > limit) throw new TooLargeError(message);
  const raw = await readLimited(req, limit, message);
  try {
    return await new Response(raw, { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return null;
  }
}
