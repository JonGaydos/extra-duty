import { ValidationError } from "./errors";

const NAME_MESSAGE = "Enter a name with at least one letter";

/** A contact's name: blank is null; anything else is trimmed and must contain a letter (so "123" is refused). */
export function cleanContactName(v: string | null | undefined): string | null {
  const t = typeof v === "string" ? v.trim() : "";
  if (!t) return null;
  if (!/\p{L}/u.test(t)) throw new ValidationError(`${NAME_MESSAGE}.`);
  return t;
}

/** For edits: an unchanged name is kept as saved, even one saved before this rule; a changed one must pass. */
export function cleanChangedContactName(next: string | null | undefined, saved: string | null): string | null {
  const t = typeof next === "string" ? next.trim() : "";
  if (t === (saved ?? "").trim()) return saved;
  return cleanContactName(t);
}
