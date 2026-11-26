import { sql } from "drizzle-orm";
import { assertCan } from "@/domain/auth/policy";
import { exportTables } from "@/domain/export/export";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { streamFrom, writeZip } from "@/lib/zip";

export const dynamic = "force-dynamic";

/**
 * Every table as a zip of JSON or CSV files, streamed from one read-only snapshot. W-9 and other files are listed
 * by id, not included. Admins and API keys only. apiHandler takes a promise; the stream does the waiting, so the
 * response is returned already resolved.
 */
export const GET = apiHandler(routes["GET /export"], ({ actor, query, run }) => {
  assertCan(actor, "data.readAll");
  const body = streamFrom((emit) =>
    run(async (tx) => {
      await tx.execute(sql`set transaction isolation level repeatable read read only`);
      await writeZip(exportTables(actor, tx, query.format), emit);
    }),
  );
  const day = new Date().toISOString().slice(0, 10);
  return Promise.resolve(
    new Response(body, {
      headers: {
        "content-type": "application/zip",
        "content-disposition": `attachment; filename="extra-duty-export-${day}-${query.format}.zip"`,
        "x-content-type-options": "nosniff",
        "cache-control": "no-store",
      },
    }),
  );
});
