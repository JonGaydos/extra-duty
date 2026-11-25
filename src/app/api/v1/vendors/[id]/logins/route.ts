import { createVendorLogin } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /vendors/{id}/logins"], async ({ actor, params, body, run }) => run((tx) => createVendorLogin(actor, tx, params.id, body)));
