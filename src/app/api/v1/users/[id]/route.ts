import { updateUser } from "@/domain/users/users";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const PATCH = apiHandler(routes["PATCH /users/{id}"], async ({ actor, params, body, run }) => run((tx) => updateUser(actor, tx, params.id, body)));
