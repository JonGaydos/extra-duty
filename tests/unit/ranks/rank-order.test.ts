import { describe, expect, test } from "vitest";
import { arrangeRanks, isEligible, ladderHighestFirst, outsideLadder, ranksAtOrAbove, relinkRanks, type Rank } from "@/domain/ranks/ranks";

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

describe("the ladder on screen", () => {
  test("is shown highest first, with ranks outside the ladder apart", () => {
    expect(ladderHighestFirst(ranks).map((r) => r.id)).toEqual(["Deputy", "CSO", "Posse"]);
    expect(outsideLadder(ranks).map((r) => r.id)).toEqual(["Dispatcher"]);
  });

  test("Higher moves a rank up the screen and up the ladder", () => {
    const after = arrangeRanks(ranks, { kind: "move", id: "CSO", direction: "higher" });
    expect(ladderHighestFirst(after).map((r) => r.id)).toEqual(["CSO", "Deputy", "Posse"]);
    expect(ranksAtOrAbove("Deputy", after)).toEqual(["Deputy", "CSO"]);
  });

  test("Lower moves it down; the lowest and highest stay put at the ends", () => {
    expect(ladderHighestFirst(arrangeRanks(ranks, { kind: "move", id: "CSO", direction: "lower" })).map((r) => r.id)).toEqual(["Deputy", "Posse", "CSO"]);
    expect(ladderHighestFirst(arrangeRanks(ranks, { kind: "move", id: "Deputy", direction: "higher" })).map((r) => r.id)).toEqual(["Deputy", "CSO", "Posse"]);
  });

  test("a rank joins the ladder at the chosen place, counted from the top", () => {
    const after = arrangeRanks(ranks, { kind: "ladder", id: "Dispatcher", inLadder: true, place: 2 });
    expect(ladderHighestFirst(after).map((r) => r.id)).toEqual(["Deputy", "Dispatcher", "CSO", "Posse"]);
    expect(outsideLadder(after)).toEqual([]);
  });
});

describe("eligibility follows the ladder", () => {
  const posse = ["Posse", "CSO", "Deputy"];
  const cso = ["CSO", "Deputy"];
  const deputy = ["Deputy"];
  const dispatcher = ["Dispatcher"];

  test("moving a rank keeps a higher rank filling a lower rank's spot", () => {
    const after = arrangeRanks(ranks, { kind: "move", id: "CSO", direction: "higher" });
    expect(relinkRanks(posse, ranks, after).sort((a, b) => a.localeCompare(b))).toEqual(["CSO", "Deputy", "Posse"]);
    // CSO is now the highest: Deputies no longer fill CSO spots, and CSOs fill Deputy spots.
    expect(relinkRanks(cso, ranks, after)).toEqual(["CSO"]);
    expect(relinkRanks(deputy, ranks, after)).toEqual(["Deputy", "CSO"]);
    expect(relinkRanks(dispatcher, ranks, after)).toEqual(["Dispatcher"]);
  });

  test("moving a rank back undoes it", () => {
    const up = arrangeRanks(ranks, { kind: "move", id: "CSO", direction: "higher" });
    const back = arrangeRanks(up, { kind: "move", id: "CSO", direction: "lower" });
    expect(relinkRanks(relinkRanks(cso, ranks, up), up, back)).toEqual(cso);
    expect(relinkRanks(relinkRanks(deputy, ranks, up), up, back)).toEqual(deputy);
  });

  test("a rank taken outside the ladder fills only its own spots", () => {
    const after = arrangeRanks(ranks, { kind: "ladder", id: "CSO", inLadder: false });
    expect(relinkRanks(posse, ranks, after)).toEqual(["Posse", "Deputy"]);
    expect(relinkRanks(cso, ranks, after)).toEqual(["CSO"]);
    expect(relinkRanks(deputy, ranks, after)).toEqual(["Deputy"]);
  });

  test("a rank brought into the ladder fills the spots below it and is filled by those above", () => {
    const after = arrangeRanks(ranks, { kind: "ladder", id: "Dispatcher", inLadder: true, place: 2 });
    expect(relinkRanks(posse, ranks, after)).toEqual(["Posse", "CSO", "Dispatcher", "Deputy"]);
    expect(relinkRanks(deputy, ranks, after)).toEqual(["Deputy"]);
    expect(relinkRanks(dispatcher, ranks, after)).toEqual(["Dispatcher", "Deputy"]);
  });

  test("a hand-picked list only loses a rank that left the ladder", () => {
    const after = arrangeRanks(ranks, { kind: "ladder", id: "CSO", inLadder: false });
    expect(relinkRanks(["Posse", "CSO"], ranks, after)).toEqual(["Posse"]);
    expect(relinkRanks(["Posse", "Deputy"], ranks, after)).toEqual(["Posse", "Deputy"]);
  });
});
