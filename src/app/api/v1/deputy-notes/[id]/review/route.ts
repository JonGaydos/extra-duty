import { reviewDeputyNote } from "@/domain/deputy-notes/deputy-notes";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /deputy-notes/{id}/review"], async ({ actor, params, body, run }) => run((tx) => reviewDeputyNote(actor, tx, params.id, body)));
