import { assertCan } from "@/domain/auth/policy";
import { managedVendorIdsOf, setManagedVendors } from "@/domain/vendors/managers";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** The vendors a deputy manages. */
export const GET = apiHandler(routes["GET /users/{id}/managed-vendors"], async ({ actor, params, run }) =>
  run(async (tx) => {
    assertCan(actor, "user.manage");
    return { vendorIds: await managedVendorIdsOf(tx, params.id) };
  }),
);

/** Sets the vendors a deputy manages; audited. */
export const PUT = apiHandler(routes["PUT /users/{id}/managed-vendors"], async ({ actor, params, body, run }) =>
  run(async (tx) => ({ vendorIds: await setManagedVendors(actor, tx, params.id, body.vendorIds) })),
);
