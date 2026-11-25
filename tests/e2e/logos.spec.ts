import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import sharp from "sharp";
import { COORD } from "./coordinator-fixtures";
import { E2E } from "./env";
import { signInAs } from "./session";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const THEMES = [
  { name: "day", colorScheme: "light" },
  { name: "night", colorScheme: "dark" },
] as const;

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

async function expectNoSeriousA11yIssues(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Synthetic logos: a 3:1 wordmark on wide transparent margins (transparent), and a round seal on a white square JPG (opaque). */
const wideLogo = async () =>
  sharp({ create: { width: 1200, height: 700, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 900, height: 300, channels: 4, background: "#123c8c" } }).png().toBuffer(), gravity: "centre" }])
    .png()
    .toBuffer();
const roundLogo = async () =>
  sharp({ create: { width: 600, height: 600, channels: 3, background: "#ffffff" } })
    .composite([{ input: Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="400" height="400"><circle cx="200" cy="200" r="200" fill="#5b3ba8"/></svg>'), gravity: "centre" }])
    .jpeg()
    .toBuffer();

async function upload(page: Page, name: string, mimeType: string, buffer: Buffer) {
  const res = await page.request.post("/api/v1/agency/logo", { multipart: { logo: { name, mimeType, buffer } } });
  expect(res.status(), await res.text()).toBe(200);
}

/** The drawn logo's box in CSS pixels, and the plate's background as rgb numbers. */
async function measure(page: Page, scope: string) {
  const plate = page.locator(`${scope} [data-logo-shape]`).first();
  await expect(plate).toBeVisible();
  const img = plate.locator("img");
  await expect(img).toHaveJSProperty("complete", true);
  const box = (await img.boundingBox())!;
  const natural = await img.evaluate((el: HTMLImageElement) => ({ w: el.naturalWidth, h: el.naturalHeight }));
  const bg = await plate.evaluate((el) => getComputedStyle(el).backgroundColor);
  const [r, g, b] = (bg.match(/[\d.]+/g) ?? []).map(Number);
  return { shape: await plate.getAttribute("data-logo-shape"), box, natural, light: (r + g + b) / 3 > 200 };
}

test("a wide logo takes the wide slot on sign-in, in the header and on the invoice; a round one the square slot; only opaque logos keep the night plate", async ({ page, context, browser }) => {
  await signInAs(context, "admin");
  await page.setViewportSize(DESKTOP);
  await upload(page, "wordmark.png", "image/png", await wideLogo());

  for (const theme of THEMES) {
    const out = await browser.newContext({ colorScheme: theme.colorScheme });
    const p = await out.newPage();
    for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
      await p.setViewportSize(viewport);
      await p.goto("/sign-in");
      const m = await measure(p, "main");
      expect(m.shape).toBe("wide");
      expect(m.box.width).toBeLessThanOrEqual(240.5);
      expect(m.box.height).toBeLessThanOrEqual(88.5);
      expect(Math.abs(m.box.width / m.box.height - m.natural.w / m.natural.h)).toBeLessThan(0.05);
      // White by day; at night a transparent logo has no plate.
      expect(m.light).toBe(theme.name === "day");
      await p.screenshot({ path: `${E2E.screenshotDir}/logo-wide-signin-${size}-${theme.name}.png` });
      await expectNoSeriousA11yIssues(p);
    }
    await out.close();
  }
  expect((await rows<{ value: { agency: { logoWidth: number; logoHeight: number } } }>("select value from settings limit 1"))[0].value.agency).toMatchObject({ logoWidth: 512, logoHeight: 171, logoTransparent: true });

  // The app header: desktop top nav and the staff phone header, in night mode with no plate behind a transparent logo.
  const staff = await browser.newContext({ colorScheme: "dark" });
  await signInAs(staff, "coordinator");
  const s = await staff.newPage();
  await s.setViewportSize(DESKTOP);
  await s.goto("/coordinate");
  let m = await measure(s, "header[data-shell=top-nav]");
  expect(m).toMatchObject({ shape: "wide", light: false });
  expect(m.box.width).toBeLessThanOrEqual(96.5);
  expect(m.box.height).toBeLessThanOrEqual(40.5);
  await s.screenshot({ path: `${E2E.screenshotDir}/logo-wide-header-desktop-night.png` });
  await s.setViewportSize(PHONE);
  m = await measure(s, "header[data-shell=phone-header]");
  expect(m).toMatchObject({ shape: "wide", light: false });
  await s.screenshot({ path: `${E2E.screenshotDir}/logo-wide-header-phone-night.png` });

  // The invoice PDF draws the processed logo.
  const [inv] = await rows<{ id: string }>("select i.id from invoices i join assignments a on a.id = i.assignment_id join jobs j on j.id = a.job_id where j.title = $1", [COORD.issueJob]);
  const pdf = await s.request.get(`/api/v1/invoices/${inv.id}/pdf`);
  expect(pdf.status()).toBe(200);
  const bytes = await pdf.body();
  expect(bytes.includes(Buffer.from("/Subtype /Image"))).toBe(true);
  expect(bytes.includes(Buffer.from("/Width 512"))).toBe(true);
  await staff.close();

  // A round JPG on a white square: trimmed to the seal and shown in the square slot.
  await upload(page, "seal.jpg", "image/jpeg", await roundLogo());
  const out = await browser.newContext({ colorScheme: "light" });
  const p = await out.newPage();
  await p.setViewportSize(PHONE);
  await p.goto("/sign-in");
  const round = await measure(p, "main");
  expect(round.shape).toBe("square");
  expect(round.box.width).toBeLessThanOrEqual(88.5);
  expect(Math.abs(round.box.width - round.box.height)).toBeLessThanOrEqual(2);
  await p.screenshot({ path: `${E2E.screenshotDir}/logo-round-signin-phone-day.png` });
  await out.close();

  // In the header the round JPG is 40 px tall, and at night it keeps the light plate because it has no transparency.
  const night = await browser.newContext({ colorScheme: "dark" });
  await signInAs(night, "coordinator");
  const n = await night.newPage();
  for (const [shell, viewport] of [["top-nav", DESKTOP], ["phone-header", PHONE]] as const) {
    await n.setViewportSize(viewport);
    await n.goto("/coordinate");
    const h = await measure(n, `header[data-shell=${shell}]`);
    expect(h).toMatchObject({ shape: "square", light: true });
    expect(Math.round(h.box.height)).toBe(40);
    expect(Math.abs(h.box.width - h.box.height)).toBeLessThanOrEqual(2);
  }
  await night.close();

  // The admin page previews the slot it gets.
  await page.goto("/admin/agency");
  await expect(page.getByText("Square slot.")).toBeVisible();
});
