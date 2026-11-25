import { serviceWorkerSource } from "../sw";

export const dynamic = "force-static";

export function GET(): Response {
  return new Response(serviceWorkerSource(), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache",
      "service-worker-allowed": "/",
    },
  });
}
