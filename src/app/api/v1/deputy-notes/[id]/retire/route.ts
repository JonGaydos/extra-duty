import { retireDeputyNote } from "@/domain/deputy-notes/deputy-notes";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /deputy-notes/{id}/retire"], async ({ actor, params, run }) => run((tx) => retireDeputyNote(actor, tx, params.id)));
