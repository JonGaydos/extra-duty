import { normalizePhone } from "@/lib/phone";
import { ValidationError } from "./errors";

export const PHONE_MESSAGE = "Enter a 10-digit phone number";

/**
 * Every saved phone number: blank is null, anything else must be 10 US digits (a leading 1 is dropped) and is
 * stored as ###-###-####.
 */
export function cleanPhone(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return null;
  const p = normalizePhone(t);
  if (!p) throw new ValidationError(`${PHONE_MESSAGE}.`);
  return p;
}

/**
 * For edits: a phone that did not change is kept as saved, even if it was saved before this rule, so an old
 * number never blocks an unrelated change. A changed one must pass `cleanPhone`.
 */
export function cleanChangedPhone(next: string | null | undefined, saved: string | null): string | null {
  const t = typeof next === "string" ? next.trim() : "";
  if (t === (saved ?? "").trim()) return saved;
  return cleanPhone(t);
}
