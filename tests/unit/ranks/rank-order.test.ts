import { describe, expect, test } from "vitest";
import { isEligible, ranksAtOrAbove, type Rank } from "@/domain/ranks/ranks";

const mk = (id: string, sortOrder: number, inLadder = true, active = true): Rank => ({
  id,
  name: id,
  sortOrder,
  inLadder,
  active,
  createdAt: new Date(),
  updatedAt: new Date(),
});
const ranks = [mk("Posse", 1), mk("CSO", 2), mk("Deputy", 3), mk("Dispatcher", 4, false)];

describe("ranksAtOrAbove", () => {
  test("CSO and higher excludes Posse and Dispatcher", () => {
    expect(ranksAtOrAbove("CSO", ranks)).toEqual(["CSO", "Deputy"]);
  });
  test("Posse and higher includes CSO", () => {
    expect(ranksAtOrAbove("Posse", ranks)).toEqual(["Posse", "CSO", "Deputy"]);
  });
  test("input order does not matter", () => {
    expect(ranksAtOrAbove("CSO", [...ranks].reverse())).toEqual(["CSO", "Deputy"]);
  });
  test("out-of-ladder rank returns only itself", () => {
    expect(ranksAtOrAbove("Dispatcher", ranks)).toEqual(["Dispatcher"]);
  });
  test("inactive ladder ranks are skipped", () => {
    const r = [mk("Posse", 1), mk("CSO", 2, true, false), mk("Deputy", 3)];
    expect(ranksAtOrAbove("Posse", r)).toEqual(["Posse", "Deputy"]);
  });
});

describe("isEligible", () => {
  const cso = ranksAtOrAbove("CSO", ranks);
  test("a Deputy can fill a CSO position", () => expect(isEligible("Deputy", cso)).toBe(true));
  test("a Posse cannot fill a CSO position", () => expect(isEligible("Posse", cso)).toBe(false));
});
