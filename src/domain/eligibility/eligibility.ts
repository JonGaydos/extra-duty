import type { assignmentStatus } from "@/db/schema/assignments";
import type { CapResult } from "../caps/caps";
import type { CheckName, CheckResult } from "../errors";
import { isReleased, type JobState } from "../release/release";
import { agencyDateParts } from "../time/agency-time";

export type AssignmentStatus = (typeof assignmentStatus.enumValues)[number];

type JobForRules = {
  id: string;
  number: number;
  vendorId: string;
  startAt: Date;
  endAt: Date;
  state: JobState;
  held: boolean;
  /** Null means not released. */
  releaseAt: Date | null;
  vendorOnPaymentHold: boolean;
  /** The detail's real start when `startAt` is a planned (flex) start. Sign-up closes at the real start. */
  realStartAt?: Date;
};

export type EligibilityContext = {
  now: Date;
  job: JobForRules;
  position: {
    name: string;
    eligibleRankIds: string[];
    eligibleRankNames: string[];
    requiredQualificationIds: string[];
    requiredQualificationNames: string[];
    free: number;
  };
  person: { active: boolean; suspendedUntil: Date | null; rankId: string; qualificationIds: string[] };
  personAssignments: Array<{ jobId: string; jobNumber: number; startAt: Date; endAt: Date; status: AssignmentStatus }>;
  billingLock: { locked: boolean; unbilledCount: number; unacknowledgedCount: number };
  /** The W-9 sign-up lock: no approved W-9, or a requested renewal past due. */
  w9Lock: { locked: boolean; message: string };
  caps: CapResult[];
  /** Coordinator vendor restriction for this person and this job's vendor, computed by the caller. */
  restrictedFromVendor: boolean;
  rollingWindowHours: number;
};

export type EligibilityResult = { canSignUp: boolean; canBackup: boolean; checks: CheckResult[] };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function formatDate(d: Date): string {
  const p = agencyDateParts(d);
  return `${MONTHS[p.month - 1]} ${p.day}, ${p.year}`;
}

/** Minutes to hours, up to 2 decimals, no trailing zeros. */
function hours(minutes: number): string {
  return String(Math.round((minutes / 60) * 100) / 100);
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

function rankMessage(names: string[]): string {
  if (names.length <= 1) return `Requires the ${names[0] ?? ""} rank`;
  if (names.length === 2) return `Requires the ${names[0]} or ${names[1]} rank`;
  return `Requires the ${names.slice(0, -1).join(", ")} or ${names.at(-1)} rank`;
}

function billingMessage(unbilled: number, unack: number): string {
  const bill = unbilled > 0 ? `Bill ${plural(unbilled, "past detail", "past details")}` : "";
  const confirmVerb = bill ? "confirm" : "Confirm";
  const confirm = unack > 0 ? `${confirmVerb} payment on ${plural(unack, "invoice", "invoices")}` : "";
  return `${[bill, confirm].filter(Boolean).join(" and ")} to sign up again`;
}

function stateMessage(released: boolean, started: boolean): string | null {
  if (!released) return "Not open for sign-up";
  return started ? "This detail has started" : null;
}

/**
 * The checks a deputy is shown. A passing suspension check is left out: suspension is a personnel matter, so it is
 * never mentioned to someone who is not suspended. A failing one stays ("Suspended until ...") and still blocks.
 */
export function shownChecks(checks: CheckResult[]): CheckResult[] {
  return checks.filter((c) => c.check !== "suspended" || !c.ok);
}

export function evaluateSignup(ctx: EligibilityContext): EligibilityResult {
  const { now, job, position, person, billingLock } = ctx;
  const checks: CheckResult[] = [];
  const add = (check: CheckName, failMessage: string | null) =>
    checks.push({ check, ok: failMessage === null, message: failMessage ?? "" });
  const addCap = (check: CheckName, kind: CapResult["cap"], message: (c: CapResult) => string) => {
    const failing = ctx.caps.find((c) => c.cap === kind && !c.ok);
    add(check, failing ? message(failing) : null);
  };

  const released = isReleased({ held: job.held, releaseAt: job.releaseAt, state: job.state }, now);
  const started = now.getTime() >= (job.realStartAt ?? job.startAt).getTime();
  add("state", stateMessage(released, started));
  add("vendor_hold", job.vendorOnPaymentHold ? "Vendor on payment hold" : null);
  add("vendor_restricted", ctx.restrictedFromVendor ? "Not available to you. Contact a coordinator." : null);
  add("rank", position.eligibleRankIds.includes(person.rankId) ? null : rankMessage(position.eligibleRankNames));
  const missing = position.requiredQualificationIds.findIndex((id) => !person.qualificationIds.includes(id));
  add("qualification", missing === -1 ? null : `Requires the ${position.requiredQualificationNames[missing]} flag`);
  add("active", person.active ? null : "Your account is inactive. Contact a coordinator.");
  add(
    "suspended",
    person.suspendedUntil && person.suspendedUntil.getTime() > now.getTime()
      ? `Suspended until ${formatDate(person.suspendedUntil)}`
      : null,
  );
  add(
    "billing_lock",
    billingLock.locked ? billingMessage(billingLock.unbilledCount, billingLock.unacknowledgedCount) : null,
  );
  add("w9", ctx.w9Lock.locked ? ctx.w9Lock.message : null);
  const overlapping = ctx.personAssignments.find(
    (a) =>
      a.jobId !== job.id &&
      (a.status === "pending_short" || a.status === "signed_up") &&
      a.startAt.getTime() < job.endAt.getTime() &&
      a.endAt.getTime() > job.startAt.getTime(),
  );
  add("overlap", overlapping ? `Overlaps Detail #${overlapping.jobNumber}` : null);
  const n = ctx.rollingWindowHours;
  addCap(
    "cap_rolling",
    "rolling",
    (c) => `${n}-hour cap: ${hours(c.usedMinutes)} of ${hours(c.limitMinutes)} hours in any ${n} hours with this detail`,
  );
  addCap("cap_week", "week", (c) => `Week cap: ${hours(c.usedMinutes)} of ${hours(c.limitMinutes)} hours with this detail`);
  addCap("cap_month", "month", (c) => `Month cap: ${hours(c.usedMinutes)} of ${hours(c.limitMinutes)} hours with this detail`);
  const onJob = ctx.personAssignments.some(
    (a) => a.jobId === job.id && (a.status === "pending_short" || a.status === "signed_up" || a.status === "backup"),
  );
  add("already_on_job", onJob ? "You are already on this detail" : null);

  const allOk = checks.every((c) => c.ok);
  return { canSignUp: allOk && position.free > 0, canBackup: allOk && position.free === 0, checks };
}
