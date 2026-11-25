import { z } from "zod";
import { agencyDateOnly } from "@/domain/time/agency-time";

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * An API date input. A date-only value (YYYY-MM-DD) is an agency day (America/Chicago): its midnight, or with
 * `edge: "end"` its last millisecond. A full ISO timestamp is kept as sent. Anything else is refused.
 */
export function agencyDate(edge: "start" | "end" = "start") {
  return z
    .string()
    .meta({ description: "A date (YYYY-MM-DD, an agency day in America/Chicago) or an ISO 8601 timestamp.", format: "date-time" })
    .transform((v, ctx) => {
      const d = DATE_ONLY.test(v) ? agencyDateOnly(v, edge) : new Date(v);
      if (!d || Number.isNaN(d.getTime())) {
        ctx.addIssue({ code: "custom", message: "Not a valid date." });
        return z.NEVER;
      }
      return d;
    });
}
