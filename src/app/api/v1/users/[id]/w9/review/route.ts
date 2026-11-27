import { NotFoundError } from "@/domain/errors";
import { currentW9, reviewW9 } from "@/domain/w9/w9";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Approves (with the signature date and form revision) or rejects (with a reason) the person's latest W-9. */
export const POST = apiHandler(routes["POST /users/{id}/w9/review"], async ({ actor, params, body, run }) =>
  run(async (tx) => {
    const w9 = await currentW9(tx, params.id);
    if (!w9) throw new NotFoundError("No W-9 on file.");
    const row = await reviewW9(actor, tx, w9.id, body);
    return { id: row.id, status: row.status, signedOn: row.signedOn, formRevision: row.formRevision, rejectReason: row.rejectReason };
  }),
);
