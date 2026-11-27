import { describe, expect, it } from "vitest";
import { agencyInstant } from "@/domain/time/agency-time";
import { evaluateSignup, shownChecks, type EligibilityContext } from "@/domain/eligibility/eligibility";

const now = agencyInstant(2026, 11, 20, 12, 0);
const start = agencyInstant(2026, 12, 5, 8, 0);
const end = agencyInstant(2026, 12, 5, 16, 0);

function ctx(over: Partial<EligibilityContext> = {}): EligibilityContext {
  return {
    now,
    job: {
      id: "j1", number: 70000, vendorId: "v1", startAt: start, endAt: end, state: "active", held: false,
      releaseAt: agencyInstant(2026, 11, 15, 16, 0), vendorOnPaymentHold: false,
    },
    position: {
      name: "Deputy", eligibleRankIds: ["deputy"], eligibleRankNames: ["Deputy Sheriff"],
      requiredQualificationIds: [], requiredQualificationNames: [], free: 2,
    },
    person: { active: true, suspendedUntil: null, rankId: "deputy", qualificationIds: [] },
    personAssignments: [],
    billingLock: { locked: false, unbilledCount: 0, unacknowledgedCount: 0 },
    w9Lock: { locked: false, message: "" },
    caps: [],
    restrictedFromVendor: false,
    rollingWindowHours: 24,
    ...over,
  };
}

function failing(c: EligibilityContext) {
  return evaluateSignup(c).checks.filter((x) => !x.ok);
}

describe("evaluateSignup: started detail", () => {
  it("fails state with its own message once the detail has started", () => {
    const base = ctx();
    const c = ctx({ now: new Date(start.getTime() + 60_000) });
    const r = evaluateSignup(c);
    expect(r.canSignUp).toBe(false);
    expect(r.checks.find((x) => x.check === "state")).toEqual({ check: "state", ok: false, message: "This detail has started" });
    expect(evaluateSignup(base).canSignUp).toBe(true);
  });
  it("uses the real start when the job start is a planned flex start", () => {
    const base = ctx();
    const c = ctx({ now: new Date(start.getTime() + 60_000), job: { ...base.job, startAt: new Date(start.getTime() + 3_600_000), realStartAt: start } });
    expect(evaluateSignup(c).checks.find((x) => x.check === "state")?.message).toBe("This detail has started");
  });
  it("keeps the unreleased message for an unreleased job", () => {
    const base = ctx();
    const c = ctx({ job: { ...base.job, releaseAt: null } });
    expect(evaluateSignup(c).checks.find((x) => x.check === "state")?.message).toBe("Not open for sign-up");
  });
});

describe("evaluateSignup: W-9 lock", () => {
  it("fails only the w9 check with the lock's own message, after the billing lock", () => {
    const r = evaluateSignup(ctx({ w9Lock: { locked: true, message: "A new W-9 was due Jan 31" } }));
    expect(r.canSignUp).toBe(false);
    expect(r.checks.filter((c) => !c.ok)).toEqual([{ check: "w9", ok: false, message: "A new W-9 was due Jan 31" }]);
    const names = r.checks.map((c) => c.check);
    expect(names.indexOf("w9")).toBe(names.indexOf("billing_lock") + 1);
  });
});

describe("evaluateSignup", () => {
  it("passes everything for an eligible person", () => {
    const r = evaluateSignup(ctx());
    expect(r.canSignUp).toBe(true);
    expect(r.canBackup).toBe(false);
    expect(r.checks).toHaveLength(14);
    expect(r.checks.every((c) => c.ok && c.message === "")).toBe(true);
  });

  it("a full position allows backup only", () => {
    const r = evaluateSignup(ctx({ position: { ...ctx().position, free: 0 } }));
    expect(r.canSignUp).toBe(false);
    expect(r.canBackup).toBe(true);
  });

  it("a full position leaves other positions unaffected", () => {
    const full = evaluateSignup(ctx({ position: { ...ctx().position, free: 0 } }));
    const open = evaluateSignup(ctx({ position: { ...ctx().position, name: "Other", free: 3 } }));
    expect([full.canSignUp, open.canSignUp]).toEqual([false, true]);
  });

  it("state fails when not released, held, null release, or not approved", () => {
    const base = ctx().job;
    for (const job of [
      { ...base, releaseAt: agencyInstant(2026, 11, 25, 16, 0) },
      { ...base, held: true },
      { ...base, releaseAt: null },
      { ...base, state: "requested" as const },
    ]) {
      const r = evaluateSignup(ctx({ job }));
      expect(r.checks.find((c) => c.check === "state")).toEqual({ check: "state", ok: false, message: "Not open for sign-up" });
      expect(r.canSignUp).toBe(false);
      expect(r.canBackup).toBe(false);
    }
  });

  it("vendor hold and restriction", () => {
    expect(failing(ctx({ job: { ...ctx().job, vendorOnPaymentHold: true } }))).toEqual([
      { check: "vendor_hold", ok: false, message: "Vendor on payment hold" },
    ]);
    expect(failing(ctx({ restrictedFromVendor: true }))).toEqual([
      { check: "vendor_restricted", ok: false, message: "Not available to you. Contact a coordinator." },
    ]);
  });

  it("a CSO fails rank for a Deputy Sheriff position", () => {
    expect(failing(ctx({ person: { ...ctx().person, rankId: "cso" } }))).toEqual([
      { check: "rank", ok: false, message: "Requires the Deputy Sheriff rank" },
    ]);
  });

  it("a Dispatcher is eligible only for the Dispatcher position", () => {
    const person = { ...ctx().person, rankId: "dispatcher" };
    expect(evaluateSignup(ctx({ person })).canSignUp).toBe(false);
    const dispatch = { ...ctx().position, name: "Dispatcher", eligibleRankIds: ["dispatcher"], eligibleRankNames: ["Dispatcher"] };
    expect(evaluateSignup(ctx({ person, position: dispatch })).canSignUp).toBe(true);
  });

  it("rank messages list names", () => {
    const m = (names: string[]) =>
      failing(ctx({ position: { ...ctx().position, eligibleRankIds: ["x"], eligibleRankNames: names } }))[0].message;
    expect(m(["CSO", "Deputy Sheriff"])).toBe("Requires the CSO or Deputy Sheriff rank");
    expect(m(["Posse", "CSO", "Deputy Sheriff"])).toBe("Requires the Posse, CSO or Deputy Sheriff rank");
  });

  it("SRO flag gates the position until granted", () => {
    const position = {
      ...ctx().position, name: "SRO", requiredQualificationIds: ["sro"], requiredQualificationNames: ["School Resource Deputy"],
    };
    expect(failing(ctx({ position }))).toEqual([
      { check: "qualification", ok: false, message: "Requires the School Resource Deputy flag" },
    ]);
    expect(evaluateSignup(ctx({ position, person: { ...ctx().person, qualificationIds: ["sro"] } })).canSignUp).toBe(true);
  });

  it("Incident Commander flag gates the IC position", () => {
    const position = {
      ...ctx().position, name: "IC", requiredQualificationIds: ["ic"], requiredQualificationNames: ["Incident Commander"],
    };
    expect(failing(ctx({ position }))[0].message).toBe("Requires the Incident Commander flag");
    expect(evaluateSignup(ctx({ position, person: { ...ctx().person, qualificationIds: ["ic"] } })).canSignUp).toBe(true);
  });

  it("inactive and suspended", () => {
    expect(failing(ctx({ person: { ...ctx().person, active: false } }))).toEqual([
      { check: "active", ok: false, message: "Your account is inactive. Contact a coordinator." },
    ]);
    expect(failing(ctx({ person: { ...ctx().person, suspendedUntil: agencyInstant(2026, 12, 4, 12, 0) } }))).toEqual([
      { check: "suspended", ok: false, message: "Suspended until Dec 4, 2026" },
    ]);
    expect(failing(ctx({ person: { ...ctx().person, suspendedUntil: agencyInstant(2026, 11, 1, 12, 0) } }))).toEqual([]);
  });

  it("the shown checks leave out a passing suspension check but keep a failing one, which still blocks", () => {
    const clear = evaluateSignup(ctx());
    expect(clear.checks.map((c) => c.check)).toContain("suspended");
    expect(shownChecks(clear.checks).map((c) => c.check)).not.toContain("suspended");
    expect(shownChecks(clear.checks)).toHaveLength(clear.checks.length - 1);
    const suspended = evaluateSignup(ctx({ person: { ...ctx().person, suspendedUntil: agencyInstant(2026, 12, 4, 12, 0) } }));
    expect(suspended.canSignUp).toBe(false);
    expect(shownChecks(suspended.checks).filter((c) => c.check === "suspended")).toEqual([{ check: "suspended", ok: false, message: "Suspended until Dec 4, 2026" }]);
  });

  it("billing lock messages", () => {
    const m = (unbilledCount: number, unacknowledgedCount: number) =>
      failing(ctx({ billingLock: { locked: true, unbilledCount, unacknowledgedCount } }))[0].message;
    expect(m(2, 0)).toBe("Bill 2 past details to sign up again");
    expect(m(1, 0)).toBe("Bill 1 past detail to sign up again");
    expect(m(0, 1)).toBe("Confirm payment on 1 invoice to sign up again");
    expect(m(0, 3)).toBe("Confirm payment on 3 invoices to sign up again");
    expect(m(2, 1)).toBe("Bill 2 past details and confirm payment on 1 invoice to sign up again");
  });

  it("overlap uses pending_short and signed_up only, and touching is fine", () => {
    const other = (status: "signed_up" | "backup" | "canceled", s: Date, e: Date) => ({
      jobId: "j2", jobNumber: 68689, startAt: s, endAt: e, status,
    });
    const mid = agencyInstant(2026, 12, 5, 12, 0);
    expect(failing(ctx({ personAssignments: [other("signed_up", mid, agencyInstant(2026, 12, 5, 20, 0))] }))).toEqual([
      { check: "overlap", ok: false, message: "Overlaps Detail #68689" },
    ]);
    expect(failing(ctx({ personAssignments: [other("backup", mid, agencyInstant(2026, 12, 5, 20, 0))] }))).toEqual([]);
    expect(failing(ctx({ personAssignments: [other("canceled", mid, agencyInstant(2026, 12, 5, 20, 0))] }))).toEqual([]);
    expect(failing(ctx({ personAssignments: [other("signed_up", agencyInstant(2026, 12, 5, 16, 0), agencyInstant(2026, 12, 5, 20, 0))] }))).toEqual([]);
    expect(failing(ctx({ personAssignments: [other("signed_up", agencyInstant(2026, 12, 5, 0, 0), start)] }))).toEqual([]);
  });

  it("cap messages", () => {
    const cap = (c: "rolling" | "week" | "month", used: number, limit: number, ok = false) => ({
      cap: c, period: "p", usedMinutes: used, limitMinutes: limit, ok,
    });
    expect(failing(ctx({ caps: [cap("rolling", 1080, 960)] }))).toEqual([
      { check: "cap_rolling", ok: false, message: "24-hour cap: 18 of 16 hours in any 24 hours with this detail" },
    ]);
    expect(failing(ctx({ caps: [cap("week", 3000, 2880)] }))).toEqual([
      { check: "cap_week", ok: false, message: "Week cap: 50 of 48 hours with this detail" },
    ]);
    expect(failing(ctx({ caps: [cap("month", 5520, 6000)] }))[0].message).toBe("Month cap: 92 of 100 hours with this detail");
    expect(failing(ctx({ caps: [cap("month", 5550, 6000)] }))[0].message).toBe("Month cap: 92.5 of 100 hours with this detail");
    expect(failing(ctx({ caps: [cap("month", 5535, 6000)] }))[0].message).toBe("Month cap: 92.25 of 100 hours with this detail");
    expect(failing(ctx({ caps: [cap("month", 5520, 6000, true)] }))).toEqual([]);
    expect(failing(ctx({ caps: [cap("rolling", 1080, 960)], rollingWindowHours: 12 }))[0].message).toBe(
      "12-hour cap: 18 of 16 hours in any 12 hours with this detail",
    );
  });

  it("a person already on the job gets neither", () => {
    for (const status of ["pending_short", "signed_up", "backup"] as const) {
      const r = evaluateSignup(ctx({ personAssignments: [{ jobId: "j1", jobNumber: 70000, startAt: start, endAt: end, status }] }));
      expect(r.canSignUp).toBe(false);
      expect(r.canBackup).toBe(false);
      expect(r.checks.find((c) => c.check === "already_on_job")).toEqual({
        check: "already_on_job", ok: false, message: "You are already on this detail",
      });
    }
    const canceled = evaluateSignup(ctx({ personAssignments: [{ jobId: "j1", jobNumber: 70000, startAt: start, endAt: end, status: "canceled" }] }));
    expect(canceled.canSignUp).toBe(true);
  });
});
