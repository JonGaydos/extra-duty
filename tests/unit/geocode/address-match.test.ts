import { describe, expect, test } from "vitest";
import { addressDecision, matchLabel, sameAddress } from "@/lib/address-match";

describe("sameAddress", () => {
  test.each([
    ["12615 US-1, Pine Harbor, FL 32401", "12615 US 1, Pine Harbor, FL 32401"],
    ["174 Lakeview Blvd E, Gulf Haven, FL 32400", "174 Lakeview Boulevard East, Gulf Haven, Florida 32400"],
    ["5 N Main St., Town, TX 75001-1234", "5 North Main Street, Town, TX 75001"],
    ["5 north main street town tx 75001", "5 North Main Street, Town, TX 75001, United States"],
  ])("%s reads the same as %s", (a, b) => {
    expect(sameAddress(a, b)).toBe(true);
  });

  test.each([
    ["5 Main St, Town", "5 Main St, Town, TX 75001"],
    ["5 Main St, Town, TX 75001", "7 Main St, Town, TX 75001"],
    ["12 Oak Ave, Pine Harbor", "12 Oak Rd, Pine Harbor"],
  ])("%s differs from %s", (a, b) => {
    expect(sameAddress(a, b)).toBe(false);
  });
});

describe("addressDecision", () => {
  test("no match is not verified", () => {
    expect(addressDecision("1 Nowhere", null)).toBe("unverified");
  });
  test("a match that reads the same is verified", () => {
    expect(addressDecision("12615 US-1, Pine Harbor FL 32401", { label: "12615 US 1, Pine Harbor, FL 32401" })).toBe("verified");
  });
  test("a different match is offered as a suggestion", () => {
    expect(addressDecision("12615 US-1 Pine Harbor", { label: "12615 US 1, Pine Harbor, FL 32401" })).toBe("suggest");
  });
  test("blank typing is never looked at", () => {
    expect(addressDecision("   ", { label: "Anywhere" })).toBe("unverified");
  });
});

describe("matchLabel", () => {
  test("street, place, state code and ZIP from the address details", () => {
    expect(
      matchLabel({
        display_name: "174, Lakeview Boulevard East, Gulf Haven, Bayside County, Florida, 32400, United States",
        address: { house_number: "174", road: "Lakeview Boulevard East", hamlet: "Gulf Haven", state: "Florida", "ISO3166-2-lvl4": "US-FL", postcode: "32400" },
      }),
    ).toBe("174 Lakeview Boulevard East, Gulf Haven, FL 32400");
  });
  test("a place with no street falls back to the display name without the country", () => {
    expect(matchLabel({ display_name: "Pine Harbor, Bayside County, Florida, United States", address: { town: "Pine Harbor", state: "Florida" } })).toBe("Pine Harbor, Bayside County, Florida");
  });
  test("nothing usable gives null", () => {
    expect(matchLabel({})).toBeNull();
  });
});

describe("withUnit", () => {
  const label = "174 Lakeview Boulevard East, Gulf Haven, FL 32400";
  test("keeps a suite, apartment or unit number the map match leaves out, after the street", async () => {
    const { withUnit } = await import("@/lib/address-match");
    expect(withUnit("174 Lakeview Blvd E Suite 200, Gulf Haven FL", label)).toBe("174 Lakeview Boulevard East, Suite 200, Gulf Haven, FL 32400");
    expect(withUnit("174 Lakeview Blvd E, Apt 4B, Gulf Haven", label)).toBe("174 Lakeview Boulevard East, Apt 4B, Gulf Haven, FL 32400");
    expect(withUnit("174 Lakeview Blvd E #12, Gulf Haven", label)).toBe("174 Lakeview Boulevard East, #12, Gulf Haven, FL 32400");
    expect(withUnit("174 Lakeview Blvd E Unit 3, Gulf Haven", label)).toBe("174 Lakeview Boulevard East, Unit 3, Gulf Haven, FL 32400");
  });
  test("adds nothing when there is no unit, or the match already has it; FL is a state, not a floor", async () => {
    const { withUnit } = await import("@/lib/address-match");
    expect(withUnit("174 Lakeview Blvd E, Gulf Haven, FL 32400", label)).toBe(label);
    expect(withUnit("1 Main St Ste 5, Town", "1 Main Street, Suite 5, Town, TX 75001")).toBe("1 Main Street, Suite 5, Town, TX 75001");
  });
  test("with the unit kept, the typed address reads the same as the suggestion", async () => {
    const { addressDecision, withUnit } = await import("@/lib/address-match");
    const typed = "174 Lakeview Blvd E, Suite 200, Gulf Haven, FL 32400";
    expect(addressDecision(typed, { label: withUnit(typed, label) })).toBe("verified");
  });
});
