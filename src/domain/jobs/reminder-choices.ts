import { z } from "zod";
import { ValidationError } from "../errors";

/** The reminder times offered before a detail starts, in hours, longest first (owner request 2026-11-27). */
export const REMINDER_CHOICES = [72, 48, 24, 2] as const;

/** "72 hours" or "2 hours". */
export const reminderLabel = (h: number) => `${h} hours`;

/** "72 and 24 hours before", "72, 48 and 24 hours before", or "Off". */
export function reminderSummary(hours: readonly number[]): string {
  if (hours.length === 0) return "Off";
  const sorted = hours.toSorted((a, b) => b - a).map(String);
  const list = sorted.length === 1 ? sorted[0] : `${sorted.slice(0, -1).join(", ")} and ${sorted.at(-1)}`;
  return `${list} ${sorted.length === 1 && sorted[0] === "1" ? "hour" : "hours"} before`;
}

/** Reminder times, longest first, each one of the offered choices and none twice. */
export const detailReminderHoursSchema = z
  .array(z.number().int().refine((h) => (REMINDER_CHOICES as readonly number[]).includes(h), `Choose from ${REMINDER_CHOICES.join(", ")} hours.`))
  .refine((v) => new Set(v).size === v.length, "Choose each reminder time once.")
  .transform((v) => v.toSorted((a, b) => b - a));

const MAX_NOTE = 1000;

/** A detail's own reminder times as saved: null keeps the agency's, an empty list is off. Refuses anything else. */
export function cleanReminderHours(v: readonly number[] | null | undefined): number[] | null {
  if (v === null || v === undefined) return null;
  const parsed = detailReminderHoursSchema.safeParse(v);
  if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "Check the reminder times.");
  return parsed.data;
}

/** The reminder note as saved: trimmed, blank as none. */
export function cleanReminderNote(v: string | null | undefined): string | null {
  const t = v?.trim();
  if (!t) return null;
  if (t.length > MAX_NOTE) throw new ValidationError(`Keep the reminder note to ${MAX_NOTE} characters.`);
  return t;
}
