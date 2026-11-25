import { describe, expect, it, vi } from "vitest";
import { parseDate, parseJobBody, parseStates } from "@/app/api/v1/jobs/parse";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";

const actor = (role: Actor["role"]): Actor => ({ userId: "u", role, rankId: null, vendorId: null });

describe("job request parsing", () => {
  it("rejects invalid dates and statuses", () => {
    expect(() => parseDate("not a date", "From")).toThrow(ValidationError);
    expect(() => parseStates(["scheduled", "bogus"])).toThrow(ValidationError);
    expect(parseStates(["active"])).toEqual(["active"]);
  });
  it("rejects bad dates in the body", async () => {
    await expect(parseJobBody(actor("coordinator"), "job.create", { opsPlanDueAt: "zzz" })).rejects.toBeInstanceOf(ValidationError);
  });
  it("checks permission before geocoding", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      parseJobBody(actor("personnel"), "job.create", { safety: { notes: "", addresses: [{ address: "1 Main", description: "" }] } }),
    ).rejects.toBeInstanceOf(ForbiddenError);
    expect(fetchMock).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
