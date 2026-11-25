import { unhideVendor } from "@/domain/planning/preferences";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const DELETE = apiHandler(routes["DELETE /me/hidden-vendors/{vendorId}"], async ({ actor, params, run }) => {
  await run((tx) => unhideVendor(actor, tx, params.vendorId));
  return { ok: true };
});
