import { describe, expect, it } from "vitest";
import { agencyInstant } from "@/domain/time/agency-time";
import { deriveJobStatus, validatePlannedTimes, type StatusJob } from "@/domain/jobs/status";

const at = (d: number, h: number, m = 0) => agencyInstant(2035, 6, d, h, m);
const job = (over: Partial<StatusJob> = {}): StatusJob => ({
  state: "scheduled", held: false, releaseAt: at(1, 16), startAt: at(10, 17), endAt: at(10, 23),
  vendorOnPaymentHold: false, spots: 2, ...over,
});
const su = (id: string) => ({ id, status: "signed_up" as const });
const before = at(5, 12);

describe("deriveJobStatus", () => {
  it("maps terminal and pre-release states", () => {
    expect(deriveJobStatus(job({ state: "canceled" }), [], [], before)).toBe("canceled");
    expect(deriveJobStatus(job({ state: "declined" }), [], [], before)).toBe("declined");
    expect(deriveJobStatus(job({ state: "requested" }), [], [], before)).toBe("requested");
    expect(deriveJobStatus(job({ state: "scheduled" }), [], [], before)).toBe("open");
    expect(deriveJobStatus(job({ state: "scheduled" }), [], [], at(1, 15))).toBe("scheduled");
    expect(deriveJobStatus(job({ held: true }), [], [], before)).toBe("scheduled");
    expect(deriveJobStatus(job(), [], [], at(1, 15))).toBe("scheduled");
  });
  it("is open with free spots and filled when full", () => {
    expect(deriveJobStatus(job(), [su("a")], [], before)).toBe("open");
    expect(deriveJobStatus(job(), [su("a"), su("b")], [], before)).toBe("filled");
  });
  it("does not count pending_short or backups against spots", () => {
    const a = [su("a"), { id: "p", status: "pending_short" as const }, { id: "b", status: "backup" as const }];
    expect(deriveJobStatus(job(), a, [], before)).toBe("open");
  });
  it("is on_hold for a vendor on payment hold until the job starts", () => {
    expect(deriveJobStatus(job({ vendorOnPaymentHold: true }), [], [], before)).toBe("on_hold");
    expect(deriveJobStatus(job({ vendorOnPaymentHold: true }), [su("a"), su("b")], [], at(11, 0))).toBe("ready_to_bill");
  });
  it("expires when the start passes with free spots", () => {
    expect(deriveJobStatus(job(), [su("a")], [], at(10, 18))).toBe("expired");
    expect(deriveJobStatus(job(), [su("a"), su("b")], [], at(10, 18))).toBe("filled");
  });
  it("walks ready_to_bill, billed and closed after the end", () => {
    const a = [su("a"), su("b")];
    const after = at(11, 9);
    expect(deriveJobStatus(job(), a, [], after)).toBe("ready_to_bill");
    expect(deriveJobStatus(job(), a, [{ assignmentId: "a", status: "sent" }], after)).toBe("ready_to_bill");
    const both = [{ assignmentId: "a", status: "sent" as const }, { assignmentId: "b", status: "paid" as const }];
    expect(deriveJobStatus(job(), a, both, after)).toBe("billed");
    const done = [{ assignmentId: "a", status: "written_off" as const }, { assignmentId: "b", status: "paid" as const }];
    expect(deriveJobStatus(job(), a, done, after)).toBe("closed");
  });
  it("expires an unstaffed job after its end", () => {
    expect(deriveJobStatus(job(), [], [], at(11, 9))).toBe("expired");
  });
});

describe("validatePlannedTimes", () => {
  const fixed = { startAt: at(10, 17), endAt: at(10, 23), flexEarliestStartAt: null, flexLatestEndAt: null, flexAllowShorter: false };
  const flex = { ...fixed, flexEarliestStartAt: at(10, 17), flexLatestEndAt: at(11, 0) };
  it("requires exact times without flex", () => {
    expect(validatePlannedTimes(fixed, { startAt: at(10, 17), endAt: at(10, 23) })).toEqual({ shorter: false });
    expect(() => validatePlannedTimes(fixed, { startAt: at(10, 18), endAt: at(10, 23) })).toThrow(/fixed/);
  });
  it("accepts a shifted same-length plan inside the flex window", () => {
    expect(validatePlannedTimes(flex, { startAt: at(10, 17, 45), endAt: at(10, 23, 45) })).toEqual({ shorter: false });
  });
  it("refuses plans outside the window, off the quarter hour or longer", () => {
    expect(() => validatePlannedTimes(flex, { startAt: at(10, 21), endAt: at(11, 3) })).toThrow(/window/);
    expect(() => validatePlannedTimes(flex, { startAt: at(10, 17, 10), endAt: at(10, 23, 10) })).toThrow(/15-minute/);
    expect(() => validatePlannedTimes(flex, { startAt: at(10, 17), endAt: at(11, 0) })).toThrow(/longer/);
  });
  it("allows shorter only when flexAllowShorter", () => {
    const p = { startAt: at(10, 18), endAt: at(10, 23) };
    expect(() => validatePlannedTimes(flex, p)).toThrow(/shorter/);
    expect(validatePlannedTimes({ ...flex, flexAllowShorter: true }, p)).toEqual({ shorter: true });
  });
});
