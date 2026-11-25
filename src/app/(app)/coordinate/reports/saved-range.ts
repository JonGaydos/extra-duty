import { agencyDayKey } from "@/domain/time/agency-time";

const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const dayOf = (v: string) => (DAY_ONLY.test(v) ? v : agencyDayKey(new Date(v)));

/**
 * A saved report's period as the agency days the date fields show. A save stores the start and end instants
 * (agency midnight, and the last millisecond of the end day), so the day is read in agency time, never by slicing
 * the UTC text: Nov 30 ends at 05:59:59.999Z on Dec 1. Null when the report leaves the period open.
 */
export function savedDayRange(spec: { from?: string; to?: string }): { from: string; to: string } | null {
  if (!spec.from || !spec.to) return null;
  return { from: dayOf(spec.from), to: dayOf(spec.to) };
}
