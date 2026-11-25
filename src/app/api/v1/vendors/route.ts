import { createVendor, listVendors } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /vendors"], async ({ actor, query, run }) => run((tx) => listVendors(actor, tx, { active: query.active, typeId: query.typeId })));

export const POST = apiHandler(routes["POST /vendors"], async ({ actor, body, run }) => run((tx) => createVendor(actor, tx, body)));
