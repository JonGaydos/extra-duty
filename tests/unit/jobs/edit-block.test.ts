import { describe, expect, test } from "vitest";
import { editBlockReason } from "@/domain/jobs/bulk-edit";

const now = new Date("2035-06-01T12:00:00Z");
const job = (o: Partial<{ state: "scheduled" | "canceled" | "declined" | "requested"; startAt: Date }> = {}) => ({ state: "scheduled" as const, startAt: new Date("2035-06-02T12:00:00Z"), ...o });

describe("editBlockReason", () => {
  test("an upcoming approved detail can be edited", () => {
    expect(editBlockReason(job(), now)).toBeNull();
  });
  test("started and past details cannot, and say why", () => {
    expect(editBlockReason(job({ startAt: new Date("2035-06-01T11:00:00Z") }), now)).toBe("This detail has started.");
  });
  test("canceled and declined details cannot", () => {
    expect(editBlockReason(job({ state: "canceled" }), now)).toBe("Canceled or declined details cannot be changed.");
    expect(editBlockReason(job({ state: "declined" }), now)).toBe("Canceled or declined details cannot be changed.");
  });
});
