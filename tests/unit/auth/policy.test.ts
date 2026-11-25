import { describe, expect, test } from "vitest";
import { ForbiddenError } from "@/domain/errors";
import type { Actor, Role } from "@/domain/actor";
import { ACTIONS, assertCan, can, type Action } from "@/domain/auth/policy";

const actorFor = (role: Role, userId = "u1"): Actor => ({
  userId,
  role,
  rankId: role === "vendor" ? null : "rank-1",
  vendorId: role === "vendor" ? "v1" : null,
});
const admin = actorFor("admin");
const coordinator = actorFor("coordinator");
const personnel = actorFor("personnel");
const vendor = actorFor("vendor", "vu1");

// Unscoped actions: [action, admin, coordinator, personnel, vendor]
const unscoped: Array<[Action, boolean, boolean, boolean, boolean]> = [
  ["job.create", true, true, false, false],
  ["job.update", true, true, false, false],
  ["job.cancel", true, true, false, false],
  ["job.reactivate", true, true, false, false],
  ["job.signup", true, true, true, false],
  ["job.backup", true, true, true, false],
  ["job.watch", true, true, true, false],
  ["assignment.assign", true, true, false, false],
  ["assignment.remove", true, true, false, false],
  ["assignment.noShow", true, true, false, false],
  ["assignment.writeOff", true, true, false, false],
  ["invoice.review", true, true, false, false],
  ["invoice.close", true, true, false, false],
  ["billing.overrideLock", true, true, false, false],
  ["paymentIssue.report", true, true, true, false],
  ["paymentIssue.manage", true, true, false, false],
  ["user.manage", true, true, false, false],
  ["user.suspend", true, true, false, false],
  ["rank.manage", true, true, false, false],
  ["qualification.manage", true, true, false, false],
  ["qualification.request", true, true, true, false],
  ["vendor.manage", true, true, false, false],
  ["vendor.paymentHold", true, true, false, false],
  ["vendorRestriction.manage", true, true, false, false],
  ["lateCancel.waive", true, true, false, false],
  ["vendorRequest.decide", true, true, false, false],
  ["audit.read", true, true, false, false],
  ["settings.read", true, true, false, false],
  ["settings.update.rules", true, true, false, false],
  ["settings.notifications", true, true, false, false],
  ["settings.update.system", true, false, false, false],
  ["season.manage", true, true, false, false],
  ["report.run", true, true, false, false],
  ["message.send", true, true, true, false],
  ["message.sendAll", true, true, true, false],
  ["opsPlan.submit", true, true, true, false],
  ["deputyNote.submit", true, true, true, false],
  ["deputyNote.manage", true, true, false, false],
  ["apiKey.manage", true, false, false, false],
  ["data.readAll", true, false, false, false],
  ["training.switch", true, true, false, false],
  ["training.reset", true, true, false, false],
  ["training.outbox", true, true, false, false],
];

describe("unscoped actions by role", () => {
  test.each(unscoped)("%s", (action, a, c, p, v) => {
    expect(can(admin, action)).toBe(a);
    expect(can(coordinator, action)).toBe(c);
    expect(can(personnel, action)).toBe(p);
    expect(can(vendor, action)).toBe(v);
  });
});

describe("owner-scoped actions", () => {
  const ownerScoped: Action[] = ["w9.read", "w9.uploadOwn", "invoice.billOwn", "invoice.markPaidOwn", "assignment.cancelOwn", "earnings.read"];
  test.each(ownerScoped)("%s: owner, coordinator, admin only", (action) => {
    expect(can(personnel, action, { ownerUserId: personnel.userId })).toBe(true);
    expect(can(personnel, action, { ownerUserId: "someone-else" })).toBe(false);
    expect(can(personnel, action)).toBe(false);
    expect(can(coordinator, action, { ownerUserId: "someone-else" })).toBe(true);
    expect(can(coordinator, action)).toBe(true);
    expect(can(admin, action, { ownerUserId: "someone-else" })).toBe(true);
    expect(can(vendor, action, { ownerUserId: vendor.userId })).toBe(false);
    expect(can(vendor, action)).toBe(false);
  });
});

describe("vendor-scoped actions", () => {
  test("job.read: vendor only for own vendor", () => {
    expect(can(vendor, "job.read", { vendorId: "v1" })).toBe(true);
    expect(can(vendor, "job.read", { vendorId: "v2" })).toBe(false);
    expect(can(vendor, "job.read")).toBe(false);
    expect(can(personnel, "job.read")).toBe(true);
    expect(can(coordinator, "job.read", { vendorId: "v2" })).toBe(true);
    expect(can(admin, "job.read")).toBe(true);
  });

  test("vendor.read: vendor only for own vendor", () => {
    expect(can(vendor, "vendor.read", { vendorId: "v1" })).toBe(true);
    expect(can(vendor, "vendor.read", { vendorId: "v2" })).toBe(false);
    expect(can(personnel, "vendor.read")).toBe(false);
    expect(can(coordinator, "vendor.read")).toBe(true);
    expect(can(admin, "vendor.read")).toBe(true);
  });

  test("vendorContact.manage: coordinators and admins for any vendor, a vendor for its own", () => {
    expect(can(vendor, "vendorContact.manage", { vendorId: "v1" })).toBe(true);
    expect(can(vendor, "vendorContact.manage", { vendorId: "v2" })).toBe(false);
    expect(can(personnel, "vendorContact.manage", { vendorId: "v1" })).toBe(false);
    expect(can(coordinator, "vendorContact.manage", { vendorId: "v2" })).toBe(true);
    expect(can(admin, "vendorContact.manage")).toBe(true);
  });

  test("vendorLocation.manageOwn: vendor only for own vendor", () => {
    expect(can(vendor, "vendorLocation.manageOwn", { vendorId: "v1" })).toBe(true);
    expect(can(vendor, "vendorLocation.manageOwn", { vendorId: "v2" })).toBe(false);
    expect(can(vendor, "vendorLocation.manageOwn")).toBe(false);
    expect(can(personnel, "vendorLocation.manageOwn", { vendorId: "v1" })).toBe(false);
    expect(can(coordinator, "vendorLocation.manageOwn", { vendorId: "v2" })).toBe(true);
    expect(can(admin, "vendorLocation.manageOwn")).toBe(true);
  });

  test.each(["vendorRequest.submit", "vendorJob.view", "vendorJob.edit", "vendorJob.cancel"] as const)("%s: own vendor and coordinators, never personnel", (action) => {
    expect(can(vendor, action, { vendorId: "v1" })).toBe(true);
    expect(can(vendor, action, { vendorId: "v2" })).toBe(false);
    expect(can(vendor, action)).toBe(false);
    expect(can(personnel, action, { vendorId: "v1" })).toBe(false);
    expect(can(coordinator, action, { vendorId: "v2" })).toBe(true);
    expect(can(admin, action)).toBe(true);
  });

  test("invoice.vendorMarkPaid: the invoice's vendor only", () => {
    expect(can(vendor, "invoice.vendorMarkPaid", { vendorId: "v1" })).toBe(true);
    expect(can(vendor, "invoice.vendorMarkPaid", { vendorId: "v2" })).toBe(false);
    expect(can(vendor, "invoice.vendorMarkPaid")).toBe(false);
    expect(can(personnel, "invoice.vendorMarkPaid", { vendorId: "v1" })).toBe(false);
    expect(can(coordinator, "invoice.vendorMarkPaid", { vendorId: "v1" })).toBe(false);
    expect(can(admin, "invoice.vendorMarkPaid", { vendorId: "v1" })).toBe(false);
  });

  test("planning.manageOwn: any non-vendor role for their own data; the service refuses other owners", () => {
    expect(can(personnel, "planning.manageOwn", { ownerUserId: personnel.userId })).toBe(true);
    expect(can(personnel, "planning.manageOwn", { ownerUserId: "someone-else" })).toBe(false);
    expect(can(personnel, "planning.manageOwn")).toBe(false);
    expect(can(coordinator, "planning.manageOwn", { ownerUserId: coordinator.userId })).toBe(true);
    expect(can(vendor, "planning.manageOwn", { ownerUserId: vendor.userId })).toBe(false);
  });

  test("profile.updateOwn: any non-vendor role for their own profile", () => {
    expect(can(personnel, "profile.updateOwn", { ownerUserId: personnel.userId })).toBe(true);
    expect(can(personnel, "profile.updateOwn", { ownerUserId: "someone-else" })).toBe(false);
    expect(can(coordinator, "profile.updateOwn", { ownerUserId: coordinator.userId })).toBe(true);
    expect(can(vendor, "profile.updateOwn", { ownerUserId: vendor.userId })).toBe(false);
  });

  test("a vendor actor with no vendorId is denied even with matching empty ctx", () => {
    const orphan: Actor = { ...vendor, vendorId: null };
    expect(can(orphan, "job.read", {})).toBe(false);
    expect(can(orphan, "job.read", { vendorId: undefined })).toBe(false);
  });
});

describe("coverage", () => {
  test("every Action is covered by a table above", () => {
    const covered = new Set<string>([
      ...unscoped.map((r) => r[0]),
      "w9.read", "w9.uploadOwn", "invoice.billOwn", "invoice.markPaidOwn", "assignment.cancelOwn", "earnings.read", "planning.manageOwn", "profile.updateOwn",
      "job.read", "vendor.read", "vendorLocation.manageOwn", "vendorContact.manage", "invoice.vendorMarkPaid",
      "vendorRequest.submit", "vendorJob.view", "vendorJob.edit", "vendorJob.cancel",
    ]);
    expect([...ACTIONS].filter((a) => !covered.has(a))).toEqual([]);
    expect([...covered].filter((a) => !(ACTIONS as readonly string[]).includes(a))).toEqual([]);
  });

  test("opsPlan.review is not defined here", () => {
    expect((ACTIONS as readonly string[]).includes("opsPlan.review")).toBe(false);
  });
});

describe("assertCan", () => {
  test("returns when allowed", () => {
    expect(() => assertCan(coordinator, "user.suspend")).not.toThrow();
  });
  test("throws ForbiddenError when denied", () => {
    expect(() => assertCan(personnel, "user.suspend")).toThrow(ForbiddenError);
    expect(() => assertCan(coordinator, "settings.update.system")).toThrow(ForbiddenError);
  });
});
