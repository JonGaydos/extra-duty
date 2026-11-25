import { createUser, listUsers } from "@/domain/users/users";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /users"], async ({ actor, run }) => run((tx) => listUsers(actor, tx)));

export const POST = apiHandler(routes["POST /users"], async ({ actor, body, run }) => run((tx) => createUser(actor, tx, body)));
