import { verifyAuditRecord } from "@/domain/audit/records";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /audit/verify"], async ({ actor, body, run }) => run((tx) => verifyAuditRecord(actor, tx, body)));
