import { ForbiddenError, ValidationError } from "@/domain/errors";

export function parseYear(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n)) throw new ValidationError("Choose a valid year.");
  return n;
}

const TYPES = { csv: "text/csv; charset=utf-8", pdf: "application/pdf" } as const;

/** An attachment download. `nosniff` stops a browser from guessing a different type. */
export function download(body: Buffer, format: "csv" | "pdf", filename: string): Response {
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": TYPES[format],
      "content-disposition": `attachment; filename="${filename}.${format}"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
}

/** A refused report export says who may run reports (the page shows the message). Other errors pass through. */
export async function reportAccess<T>(work: Promise<T>): Promise<T> {
  try {
    return await work;
  } catch (e) {
    if (e instanceof ForbiddenError && e.message === new ForbiddenError().message) throw new ForbiddenError("Only coordinators and admins can run reports.");
    throw e;
  }
}
