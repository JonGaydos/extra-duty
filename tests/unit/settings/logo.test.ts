import sharp from "sharp";
import { describe, expect, test } from "vitest";
import { logoPng, processLogo } from "@/domain/settings/logo";

const svg = (w: number, h = w) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#123c8c"/></svg>`);
const png = (width: number, height: number) => sharp({ create: { width, height, channels: 3, background: "#ffffff" } }).png().toBuffer();
const size = async (b: Buffer) => {
  const m = await sharp(b).metadata();
  return [m.format, m.width, m.height];
};

/** A logo drawn on a larger canvas: `inner` sits in the middle of `outer`, on `background`. */
async function padded(outer: [number, number], inner: [number, number], background: string | { r: number; g: number; b: number; alpha: number }, shape: "rect" | "circle" = "rect") {
  const [iw, ih] = inner;
  const art =
    shape === "circle"
      ? Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${iw}" height="${ih}"><circle cx="${iw / 2}" cy="${ih / 2}" r="${iw / 2}" fill="#b42318"/></svg>`)
      : await sharp({ create: { width: iw, height: ih, channels: 4, background: "#123c8c" } }).png().toBuffer();
  return sharp({ create: { width: outer[0], height: outer[1], channels: 4, background } })
    .composite([{ input: art, gravity: "centre" }])
    .png()
    .toBuffer();
}

describe("agency logo conversion", () => {
  test("a PNG is redrawn, never enlarged, and capped at 512 px", async () => {
    expect(await size(await logoPng(await png(800, 400)))).toEqual(["png", 512, 256]);
    expect(await size(await logoPng(await png(64, 64)))).toEqual(["png", 64, 64]);
  });

  test("a corrupt PNG is refused", async () => {
    const good = await png(100, 100);
    await expect(logoPng(good.subarray(0, 60))).rejects.toThrow("That PNG file could not be read.");
  });

  test("a PNG wider than 5,000 pixels is refused with a size message", async () => {
    await expect(logoPng(await png(6000, 10))).rejects.toThrow("That PNG is too large. Use one at most 5,000 pixels a side.");
  });

  test("an SVG of any declared size is drawn at about 512 px", async () => {
    expect(await size(await logoPng(svg(40, 20)))).toEqual(["png", 512, 256]);
    expect(await size(await logoPng(svg(4000)))).toEqual(["png", 512, 512]);
    expect((await size(await logoPng(svg(100000))))[1]).toBeLessThanOrEqual(512);
  });

  test("an SVG too large to draw says so, and other files are refused", async () => {
    await expect(logoPng(svg(10_000_000))).rejects.toThrow("That SVG is too large. Use one at most 5,000 pixels a side.");
    await expect(logoPng(Buffer.from("hello"))).rejects.toThrow("Upload a PNG, SVG, JPG or WebP file.");
  });
});

describe("logo scaling", () => {
  test("JPG and WebP are accepted and become PNG", async () => {
    const jpg = await sharp({ create: { width: 300, height: 100, channels: 3, background: "#123c8c" } }).jpeg().toBuffer();
    const webp = await sharp({ create: { width: 300, height: 100, channels: 4, background: "#123c8c" } }).webp().toBuffer();
    for (const body of [jpg, webp]) {
      const r = await processLogo(body);
      expect(await size(r.png)).toEqual(["png", 300, 100]);
      expect([r.width, r.height]).toEqual([300, 100]);
    }
  });

  test("transparent margins are trimmed (padded)", async () => {
    const r = await processLogo(await padded([400, 400], [120, 60], { r: 0, g: 0, b: 0, alpha: 0 }));
    expect([r.width, r.height]).toEqual([120, 60]);
    const m = await sharp(r.png).metadata();
    expect([m.width, m.height, m.hasAlpha]).toEqual([120, 60, true]);
  });

  test("a uniform white margin is trimmed too", async () => {
    const r = await processLogo(await padded([500, 300], [200, 100], "#ffffff"));
    expect([r.width, r.height]).toEqual([200, 100]);
  });

  test("a round logo keeps its transparent corners and is not cropped", async () => {
    const r = await processLogo(await padded([300, 300], [200, 200], { r: 0, g: 0, b: 0, alpha: 0 }, "circle"));
    expect(Math.abs(r.width - 200)).toBeLessThanOrEqual(2);
    expect(Math.abs(r.height - 200)).toBeLessThanOrEqual(2);
    const { data, info } = await sharp(r.png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    expect(data[3]).toBe(0);
    const mid = (Math.floor(info.height / 2) * info.width + Math.floor(info.width / 2)) * 4;
    expect(data[mid + 3]).toBe(255);
  });

  test("tall and wide logos keep their ratio inside 512 px", async () => {
    const tall = await processLogo(await sharp({ create: { width: 200, height: 600, channels: 3, background: "#123c8c" } }).png().toBuffer());
    expect([tall.width, tall.height]).toEqual([171, 512]);
    const wide = await processLogo(await sharp({ create: { width: 1200, height: 400, channels: 3, background: "#123c8c" } }).png().toBuffer());
    expect([wide.width, wide.height]).toEqual([512, 171]);
  });

  test("an SVG with a script or an outside reference is refused; an inside reference is fine", async () => {
    const wrap = (inner: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="100" height="50">${inner}<rect width="100" height="50" fill="#123c8c"/></svg>`);
    const refused = "That SVG has a script or a link to an outside file. Save it without them, or upload a PNG.";
    await expect(processLogo(wrap("<script>alert(1)</script>"))).rejects.toThrow(refused);
    await expect(processLogo(wrap('<rect width="1" height="1" onload="alert(1)"/>'))).rejects.toThrow(refused);
    await expect(processLogo(wrap('<image href="https://example.com/a.png" width="10" height="10"/>'))).rejects.toThrow(refused);
    await expect(processLogo(wrap('<image xlink:href="file:///etc/passwd" width="10" height="10"/>'))).rejects.toThrow(refused);
    await expect(processLogo(wrap('<style>@import url("https://example.com/x.css");</style>'))).rejects.toThrow(refused);
    await expect(processLogo(Buffer.from('<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>&x;</text></svg>'))).rejects.toThrow(refused);
    const ok = await processLogo(wrap('<defs><rect id="a" width="10" height="10"/></defs><use href="#a"/>'));
    expect(ok.width).toBeGreaterThan(0);
  });
});

describe("logo transparency", () => {
  test("a logo with any transparent pixel is recorded as transparent; a JPG or an opaque PNG is not", async () => {
    expect((await processLogo(await padded([400, 400], [120, 60], { r: 0, g: 0, b: 0, alpha: 0 }))).transparent).toBe(true);
    expect((await processLogo(await padded([300, 300], [200, 200], { r: 0, g: 0, b: 0, alpha: 0 }, "circle"))).transparent).toBe(true);
    expect((await processLogo(await padded([500, 300], [200, 100], "#ffffff"))).transparent).toBe(false);
    expect((await processLogo(await sharp({ create: { width: 300, height: 100, channels: 3, background: "#123c8c" } }).jpeg().toBuffer())).transparent).toBe(false);
    expect((await processLogo(svg(100, 50))).transparent).toBe(false);
    const svgOnClear = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><circle cx="50" cy="50" r="50" fill="#123c8c"/></svg>');
    expect((await processLogo(svgOnClear)).transparent).toBe(true);
  });
});
