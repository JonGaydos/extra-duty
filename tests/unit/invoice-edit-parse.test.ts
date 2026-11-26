import { describe, expect, test } from "vitest";
import { ValidationError } from "@/domain/errors";
import { parseEditBody } from "@/app/api/v1/invoices/parse";

describe("parseEditBody", () => {
  test("malformed or mistyped bodies are ValidationErrors", () => {
    for (const bad of [undefined, null, "x", [], { rateCents: "70" }, { minimumBillableMinutes: Number.NaN }, { reason: 5 }, { endAt: "nope" }, { startAt: 3 }]) {
      expect(() => parseEditBody(bad)).toThrow(ValidationError);
    }
  });
  test("a good body parses", () => {
    const out = parseEditBody({ endAt: "2035-03-01T23:00:00Z", rateCents: 8000, reason: "Ran long" });
    expect(out.endAt).toEqual(new Date("2035-03-01T23:00:00Z"));
    expect(out.rateCents).toBe(8000);
    expect(out.reason).toBe("Ran long");
  });
});
