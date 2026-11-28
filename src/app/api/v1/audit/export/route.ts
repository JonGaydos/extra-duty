import { exportAuditCsv } from "@/domain/audit/records";
import { parseAuditQuery } from "@/domain/audit/search";
import { agencyDayKey } from "@/domain/time/agency-time";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

/** Streamed: the export is audited first, then the rows go out in batches. */
export const POST = apiHandler(routes["POST /audit/export"], async ({ actor, body, run }) => {
  const { stream } = await exportAuditCsv(actor, run, { query: parseAuditQuery(body.query), ids: body.ids });
  return new Response(stream, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="Audit Log - ${agencyDayKey(new Date())}.csv"`,
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
});
