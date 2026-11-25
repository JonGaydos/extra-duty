import { headers } from "next/headers";
import { getRequestContext } from "@/domain/auth/session";
import { readManualImage } from "@/domain/manuals/manuals";

export const dynamic = "force-dynamic";

/**
 * A screenshot from a user manual, for the Help pages. Only to a signed-in person whose role may read that manual;
 * anyone else, and any name that is not a plain image file, gets 404.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ manual: string; file: string }> }): Promise<Response> {
  const { manual, file } = await params;
  const ctx = await getRequestContext(await headers());
  const body = ctx ? await readManualImage(ctx.actor.role, manual, file) : null;
  if (!body) return new Response("Not found", { status: 404 });
  return new Response(new Uint8Array(body), {
    headers: {
      "content-type": file.endsWith(".png") ? "image/png" : "image/webp",
      "cache-control": "private, max-age=3600",
      "x-content-type-options": "nosniff",
    },
  });
}
