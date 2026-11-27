import { createW9Request, listW9Requests } from "@/domain/w9/requests";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Every W-9 renewal request with its counts: done, pending review, rejected and missing. */
export const GET = apiHandler(routes["GET /w9-requests"], async ({ actor, run }) => run((tx) => listW9Requests(actor, tx)));

/** Asks everyone, named people, a rank or a special flag for a new W-9 by a due date. */
export const POST = apiHandler(routes["POST /w9-requests"], async ({ actor, body, run }) => run((tx) => createW9Request(actor, tx, body)));
