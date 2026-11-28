import { describe, expect, test } from "vitest";
import type { Actor } from "@/domain/actor";
import { personalAlertTypes } from "@/domain/notifications/personal";
import { isNotificationType } from "@/domain/notifications/types";

const deputy: Actor = { userId: "u1", role: "personnel", rankId: null, vendorId: null };
const manager: Actor = { ...deputy, managedVendorIds: ["v1"] };
const coordinator: Actor = { ...deputy, role: "coordinator" };
const VENDOR_REQUESTS = ["vendor.request_submitted", "vendor.request_edited"];

describe("the alert types on a person's own Alerts list", () => {
  test("every listed type is a real notification type, listed once", () => {
    for (const a of [deputy, manager, coordinator]) {
      const types = personalAlertTypes(a).map((t) => t.type);
      expect(types.every(isNotificationType)).toBe(true);
      expect(new Set(types).size).toBe(types.length);
    }
  });

  test("a vendor manager and staff can switch off the vendor request alerts they receive", () => {
    for (const a of [manager, coordinator, { ...coordinator, role: "admin" as const }]) {
      expect(personalAlertTypes(a).map((t) => t.type)).toEqual(expect.arrayContaining(VENDOR_REQUESTS));
    }
  });

  test("a deputy who manages no vendor does not see vendor request alerts", () => {
    const types = personalAlertTypes(deputy).map((t) => t.type);
    expect(types).toContain("job.changed");
    for (const t of VENDOR_REQUESTS) expect(types).not.toContain(t);
    expect(personalAlertTypes({ ...deputy, managedVendorIds: [] }).map((t) => t.type)).not.toContain("vendor.request_submitted");
  });
});
