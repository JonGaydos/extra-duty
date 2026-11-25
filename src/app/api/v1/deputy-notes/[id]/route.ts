import { editDeputyNote } from "@/domain/deputy-notes/deputy-notes";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const PATCH = apiHandler(routes["PATCH /deputy-notes/{id}"], async ({ actor, params, body, run }) => run((tx) => editDeputyNote(actor, tx, params.id, body)));
