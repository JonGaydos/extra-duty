import { printAuditRecord } from "@/domain/audit/records";
import { parseAuditQuery } from "@/domain/audit/search";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const POST = apiHandler(routes["POST /audit/print"], async ({ actor, body, run }) => {
  const r = await run((tx) => printAuditRecord(actor, tx, { query: parseAuditQuery(body.query), ids: body.ids }, { confirmLarge: body.confirmLarge === true }));
  return new Response(new Uint8Array(r.pdf), {
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="Audit Record - ${r.recordId}.pdf"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
});
