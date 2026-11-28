import { ackTracking, ackTrackingCsv } from "@/domain/messages/acknowledgements";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";

export const GET = apiHandler(routes["GET /messages/{id}/acknowledgements"], async ({ actor, params, query, run }) => {
  if (query.format !== "csv") return run((tx) => ackTracking(actor, tx, params.id));
  const csv = await run((tx) => ackTrackingCsv(actor, tx, params.id));
  return new Response(csv, {
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": 'attachment; filename="message-acknowledgements.csv"',
      "x-content-type-options": "nosniff",
      "cache-control": "no-store",
    },
  });
});
