import { setVendorActive, updateVendor } from "@/domain/vendors/vendors";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Body is vendor fields, or { active } alone to deactivate or reactivate. */
export const PATCH = apiHandler(routes["PATCH /vendors/{id}"], async ({ actor, params, body, run }) => {
  const { active, ...fields } = body;
  return run(async (tx) => {
    let row = await updateVendor(actor, tx, params.id, fields);
    if (typeof active === "boolean") row = await setVendorActive(actor, tx, params.id, active);
    return row;
  });
});
