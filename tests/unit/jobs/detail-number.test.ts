import { describe, expect, test } from "vitest";
import { detailName, detailRef, detailTitle, parseDetailNumber } from "@/domain/jobs/detail-name";

describe("detail numbers", () => {
  test("one format: #9 in tight places, Detail #9 on its own, #9 Title with the title", () => {
    expect(detailRef(9)).toBe("#9");
    expect(detailName(9)).toBe("Detail #9");
    expect(detailTitle({ number: 9, title: "Harbor fireworks" })).toBe("#9 Harbor fireworks");
  });

  test("a number, with or without #, is a detail number; an id or other text is not", () => {
    expect(parseDetailNumber("9")).toBe(9);
    expect(parseDetailNumber(" #123 ")).toBe(123);
    expect(parseDetailNumber("01a21d8d-e937-700e-805c-a176fa1694f6")).toBeNull();
    expect(parseDetailNumber("9a")).toBeNull();
    expect(parseDetailNumber("")).toBeNull();
    expect(parseDetailNumber("1234567890")).toBeNull();
  });
});
