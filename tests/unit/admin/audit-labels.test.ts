import { describe, expect, test } from "vitest";
import { auditLabel } from "@/domain/audit/labels";

describe("audit labels", () => {
  test("known actions read plainly, others are built from the key", () => {
    expect(auditLabel("settings.update")).toBe("Settings changed");
    expect(auditLabel("season.update")).toBe("Season changed");
    expect(auditLabel("position_type.deactivate")).toBe("Position type turned off");
    expect(auditLabel("vendor.payment_hold_place")).toBe("Vendor payment hold place");
    expect(auditLabel("job.rate_override")).toBe("Rate approved outside the agency range");
  });
});
