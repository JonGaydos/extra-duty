export type CheckName =
  | "state"
  | "vendor_hold"
  | "vendor_restricted"
  | "rank"
  | "qualification"
  | "active"
  | "suspended"
  | "billing_lock"
  | "w9"
  | "overlap"
  | "cap_rolling"
  | "cap_week"
  | "cap_month"
  | "already_on_job";

/** Eligibility checks use `CheckName`; other services use dotted names such as "rank.reorder.complete". */
export type CheckResult = { check: CheckName | `${string}.${string}`; ok: boolean; message: string };

export class DomainError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = "Sign in required.") {
    super("unauthenticated", message);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "You do not have permission to do that.") {
    super("forbidden", message);
  }
}

export class NotFoundError extends DomainError {
  constructor(message = "Not found.") {
    super("not_found", message);
  }
}

export class ValidationError extends DomainError {
  constructor(message: string) {
    super("validation", message);
  }
}

export class RuleViolation extends DomainError {
  readonly checks: CheckResult[];
  /** Extra values for the screen (a schedule conflict's fingerprints per detail). */
  fields?: Record<string, string>;
  constructor(checks: CheckResult[], message = "One or more rules were not met.") {
    super("rule_violation", message);
    this.checks = checks;
  }
}
