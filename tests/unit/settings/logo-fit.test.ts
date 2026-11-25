import { describe, expect, test } from "vitest";
import { LOGO_SLOTS, WIDE_RATIO, containSize, logoShape, logoSlot } from "@/lib/logo-fit";

/** The drawn size of a width by height logo in a place: its slot, then contained in it. */
const drawn = (place: "signIn" | "header" | "pdf", w: number, h: number) => {
  const slot = logoSlot(place, w, h);
  return { shape: slot.shape, ...containSize(w, h, slot) };
};

describe("logo shape", () => {
  test("the wide slot starts at about 1.3:1", () => {
    expect(WIDE_RATIO).toBe(1.3);
  });

  test.each([
    [600, 200, "wide"],
    [400, 200, "wide"],
    [300, 200, "wide"],
    [520, 400, "wide"],
    [548, 400, "wide"],
    [510, 400, "square"],
    [400, 400, "square"],
    [340, 400, "square"],
    [100, 300, "square"],
  ] as const)("%i by %i is %s", (w, h, shape) => {
    expect(logoShape(w, h)).toBe(shape);
  });

  test("an unknown size is square", () => {
    expect(logoShape(null, null)).toBe("square");
    expect(logoShape(0, 0)).toBe("square");
  });
});

describe("header fit: 40 px tall, wide logos as wide as their ratio needs up to 96 px", () => {
  test.each([
    ["1.0", 400, 400, "square", 40, 40],
    ["1.3", 520, 400, "wide", 52, 40],
    ["1.37", 548, 400, "wide", 55, 40],
    ["1.6", 640, 400, "wide", 64, 40],
    ["0.85", 340, 400, "square", 34, 40],
  ] as const)("a %s:1 logo", (_r, w, h, shape, width, height) => {
    expect(drawn("header", w, h)).toEqual({ shape, width, height });
  });

  test("a very wide logo is capped at 96 px and keeps its ratio", () => {
    expect(drawn("header", 512, 171)).toEqual({ shape: "wide", width: 96, height: 32 });
  });

  test("the header slots", () => {
    expect(LOGO_SLOTS.header).toEqual({ square: { width: 40, height: 40 }, wide: { width: 96, height: 40 } });
  });
});

describe("sign-in and PDF use the same threshold with their own base size", () => {
  test.each([
    ["signIn", 88],
    ["pdf", 56],
  ] as const)("%s", (place, base) => {
    expect(drawn(place, 400, 400)).toEqual({ shape: "square", width: base, height: base });
    expect(drawn(place, 340, 400)).toEqual({ shape: "square", width: Math.round((340 / 400) * base), height: base });
    expect(drawn(place, 520, 400)).toEqual({ shape: "wide", width: Math.round(1.3 * base), height: base });
    expect(drawn(place, 548, 400)).toEqual({ shape: "wide", width: Math.round(1.37 * base), height: base });
    expect(drawn(place, 640, 400)).toEqual({ shape: "wide", width: Math.round(1.6 * base), height: base });
  });
});

describe("contain fit", () => {
  test("a wide logo fills the width of a wide box and keeps its ratio", () => {
    expect(containSize(600, 200, { width: 240, height: 88 })).toEqual({ width: 240, height: 80 });
  });
  test("a tall logo fills the height of a square box and is never stretched", () => {
    expect(containSize(100, 300, { width: 88, height: 88 })).toEqual({ width: 29, height: 88 });
  });
  test("a round (square) logo fills a square box exactly", () => {
    expect(containSize(512, 512, { width: 56, height: 56 })).toEqual({ width: 56, height: 56 });
  });
  test("the ratio is kept within rounding for any size", () => {
    for (const [w, h] of [
      [512, 171],
      [37, 500],
      [499, 248],
    ]) {
      const box = { width: 150, height: 56 };
      const r = containSize(w, h, box);
      expect(r.width).toBeLessThanOrEqual(box.width);
      expect(r.height).toBeLessThanOrEqual(box.height);
      expect(r.width === box.width || r.height === box.height).toBe(true);
      expect(Math.abs(r.width / r.height - w / h)).toBeLessThan(0.1);
    }
  });
});

describe("slots", () => {
  test("wide logos get the wider slot on sign-in, in the header and on the PDF", () => {
    for (const place of ["signIn", "header", "pdf"] as const) {
      expect(logoSlot(place, 600, 200)).toEqual({ shape: "wide", ...LOGO_SLOTS[place].wide });
      expect(logoSlot(place, 300, 300)).toEqual({ shape: "square", ...LOGO_SLOTS[place].square });
      expect(LOGO_SLOTS[place].wide.width).toBeGreaterThan(LOGO_SLOTS[place].square.width);
      expect(LOGO_SLOTS[place].wide.height).toBe(LOGO_SLOTS[place].square.height);
    }
  });
});
