import { reactivateUser } from "@/domain/users/users";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /users/{id}/reactivate"], async ({ actor, params, body, run }) => run((tx) => reactivateUser(actor, tx, params.id, body.reason)));
