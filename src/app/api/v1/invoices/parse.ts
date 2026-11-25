import { ValidationError } from "@/domain/errors";
import type { EditInvoiceInput } from "@/domain/invoices/review";
import { parseDate } from "@/app/api/v1/jobs/parse";

/** Validates the edit body; anything malformed is a ValidationError (400), never a raw parse or type error. */
export function parseEditBody(body: unknown): EditInvoiceInput {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("Send the changes as a JSON object.");
  const b = body as Record<string, unknown>;
  const num = (v: unknown, label: string): number | undefined => {
    if (v === undefined) return undefined;
    if (typeof v !== "number" || !Number.isFinite(v)) throw new ValidationError(`${label} must be a number.`);
    return v;
  };
  if (b.reason !== undefined && typeof b.reason !== "string") throw new ValidationError("Reason must be text.");
  return {
    startAt: b.startAt === undefined ? undefined : parseDate(b.startAt, "Start"),
    endAt: b.endAt === undefined ? undefined : parseDate(b.endAt, "End"),
    rateCents: num(b.rateCents, "Rate"),
    minimumBillableMinutes: num(b.minimumBillableMinutes, "Minimum"),
    reason: (b.reason as string | undefined) ?? "",
  };
}
