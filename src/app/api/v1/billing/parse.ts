import { ValidationError } from "@/domain/errors";
import type { CloseInput } from "@/domain/billing/payments";

function object(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new ValidationError("Send the details as a JSON object.");
  return body as Record<string, unknown>;
}

export function parseCloseBody(body: unknown): CloseInput {
  const b = object(body);
  if (b.outcome !== "paid" && b.outcome !== "written_off") throw new ValidationError("Choose Paid or Written off.");
  if (b.reason !== undefined && typeof b.reason !== "string") throw new ValidationError("Reason must be text.");
  return { outcome: b.outcome, reason: (b.reason as string | undefined) ?? "" };
}
