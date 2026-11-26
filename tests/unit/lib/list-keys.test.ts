import { describe, expect, test } from "vitest";
import { carryRowKeys, keyedByContent } from "@/lib/list-keys";

describe("keyedByContent", () => {
  test("keys follow the content, not the position", () => {
    const before = keyedByContent(["a", "b", "c"]).map((x) => x.key);
    const after = keyedByContent(["b", "c"]).map((x) => x.key);
    expect(after).toEqual(before.slice(1));
  });

  test("repeated content gets distinct keys and the item and index come back", () => {
    const out = keyedByContent(["x", "x", "1:x"], (s) => s);
    expect(new Set(out.map((x) => x.key)).size).toBe(3);
    expect(out.map((x) => [x.item, x.index])).toEqual([["x", 0], ["x", 1], ["1:x", 2]]);
  });
});

describe("carryRowKeys", () => {
  let n = 0;
  const next = () => `k${++n}`;

  test("a removed row takes its key with it", () => {
    const a = { v: 1 };
    const b = { v: 2 };
    const c = { v: 3 };
    const first = carryRowKeys([a, b, c], { rows: [], keys: [] }, next);
    expect(carryRowKeys([a, c], { rows: [a, b, c], keys: first }, next)).toEqual([first[0], first[2]]);
  });

  test("a row edited in place keeps its key, and an added row gets a new one", () => {
    const a = { v: 1 };
    const b = { v: 2 };
    const first = carryRowKeys([a, b], { rows: [], keys: [] }, next);
    const edited = { v: 5 };
    expect(carryRowKeys([a, edited], { rows: [a, b], keys: first }, next)).toEqual(first);
    const added = carryRowKeys([a, b, { v: 3 }], { rows: [a, b], keys: first }, next);
    expect(added.slice(0, 2)).toEqual(first);
    expect(first).not.toContain(added[2]);
  });

  test("never repeats a key", () => {
    const a = { v: 1 };
    const b = { v: 2 };
    const first = carryRowKeys([a, b], { rows: [], keys: [] }, next);
    const out = carryRowKeys([b, { v: 3 }], { rows: [a, b], keys: first }, next);
    expect(new Set(out).size).toBe(2);
    expect(out[0]).toBe(first[1]);
  });

  test("a row that moved keeps its key before a new row takes that position's key", () => {
    const a = { v: 1 };
    const b = { v: 2 };
    const first = carryRowKeys([a, b], { rows: [], keys: [] }, next);
    const out = carryRowKeys([{ v: 3 }, a], { rows: [a, b], keys: first }, next);
    expect(out[1]).toBe(first[0]);
    expect(out[0]).not.toBe(first[0]);
  });
});
