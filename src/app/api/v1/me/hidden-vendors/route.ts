import { hideVendor, listHiddenVendors } from "@/domain/planning/preferences";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /me/hidden-vendors"], async ({ actor, run }) => run((tx) => listHiddenVendors(actor, tx, actor.userId)));

export const POST = apiHandler(routes["POST /me/hidden-vendors"], async ({ actor, body, run }) => {
  await run((tx) => hideVendor(actor, tx, body.vendorId));
  return { ok: true };
});
