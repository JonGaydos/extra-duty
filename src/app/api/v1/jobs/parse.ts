import type { JobInput, JobSort } from "@/domain/jobs/jobs";
import type { Actor } from "@/domain/actor";
import { assertCan, type Action } from "@/domain/auth/policy";
import { ValidationError } from "@/domain/errors";
import { resolveSafetyPins } from "@/domain/jobs/safety";
import type { JobState } from "@/domain/release/release";

const JOB_STATES: readonly JobState[] = ["requested", "scheduled", "active", "canceled", "declined"];

/**
 * Parses an ISO timestamp for an instant (a start, an end, a due time), or throws ValidationError instead of letting
 * an invalid Date reach the database. A date-only value is refused: it would read as UTC midnight, the evening
 * before in agency time.
 */
export function parseDate(v: unknown, label: string): Date {
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v.trim())) throw new ValidationError(`${label} needs a date and time, such as 2026-03-08T17:00:00-06:00.`);
  const d = typeof v === "string" ? new Date(v) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid date.`);
  return d;
}

export function parseStates(list: string[] | undefined): JobState[] | undefined {
  if (!list) return undefined;
  for (const v of list) if (!(JOB_STATES as readonly string[]).includes(v)) throw new ValidationError(`Unknown status: ${v}.`);
  return list as JobState[];
}

/**
 * The list window from the parsed query (a date-only from and to are already agency days). "Only details I can
 * work" is bounded: 90 days from `from` (default now) when `to` is missing.
 */
export function parseWindow(fromParam: Date | undefined, toParam: Date | undefined, onlyWorkable: boolean, now: number): { from: Date; to: Date } {
  const from = fromParam ?? (onlyWorkable ? new Date(now) : new Date(0));
  const to = toParam ?? (onlyWorkable ? new Date(from.getTime() + 90 * 86_400_000) : new Date("9999-12-31"));
  return { from, to };
}

const SORTS: readonly JobSort[] = ["date", "vendor", "location", "rate", "total_pay"];

export function parseSort(v: string | null): JobSort | undefined {
  if (v === null) return undefined;
  if (!(SORTS as readonly string[]).includes(v)) throw new ValidationError(`Unknown sort: ${v}.`);
  return v as JobSort;
}

export function parseDirection(v: string | null): "asc" | "desc" | undefined {
  if (v === null) return undefined;
  if (v !== "asc" && v !== "desc") throw new ValidationError("The direction must be asc or desc.");
  return v;
}

type Wire = Omit<Partial<JobInput>, "startAt" | "endAt" | "opsPlanDueAt" | "flex"> & {
  startAt?: string;
  endAt?: string;
  opsPlanDueAt?: string | null;
  flex?: { earliestStartAt: string; latestEndAt: string; allowShorter: boolean } | null;
};

/** JSON body to JobInput fields: ISO strings become Dates and safety pins are looked up before any transaction opens. */
export async function parseJobBody(actor: Actor, action: Action, body: Wire): Promise<Partial<JobInput>> {
  assertCan(actor, action);
  const { startAt, endAt, opsPlanDueAt, flex, safety, ...rest } = body;
  const out: Partial<JobInput> = { ...rest };
  if (startAt !== undefined) out.startAt = parseDate(startAt, "Start time");
  if (endAt !== undefined) out.endAt = parseDate(endAt, "End time");
  if (opsPlanDueAt !== undefined) out.opsPlanDueAt = opsPlanDueAt === null ? null : parseDate(opsPlanDueAt, "Ops plan due time");
  if (flex !== undefined) {
    out.flex = flex && { earliestStartAt: parseDate(flex.earliestStartAt, "Earliest start"), latestEndAt: parseDate(flex.latestEndAt, "Latest end"), allowShorter: flex.allowShorter };
  }
  if (safety) out.safety = await resolveSafetyPins(safety);
  return out;
}
