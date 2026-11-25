import type { Page } from "@playwright/test";
import { PHONE, agencyAt, expect, test } from "../fixtures";

/** Anchors in main that are not underlined (button-styled links, nav items and card links that underline their title aside). */
async function bareLinks(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLAnchorElement>("#main a")]
      .filter((a) => a.getClientRects().length > 0)
      .filter((a) => {
        if (a.hasAttribute("data-button-link") || a.hasAttribute("data-nav-item") || a.closest("nav") || a.getAttribute("role") === "button") return false;
        const underlined = (el: Element) => getComputedStyle(el).textDecorationLine.includes("underline");
        if (a.hasAttribute("data-card-link")) return ![...a.querySelectorAll("*")].some(underlined);
        return !underlined(a);
      })
      .map((a) => a.outerHTML.slice(0, 140)),
  );
}

const mainTop = (page: Page) => page.evaluate(() => Math.round(document.getElementById("main")!.scrollTop));

/**
 * The phone shell at 390 by 844, as a deputy uses it: the bottom tab bar stays pinned while the list scrolls, links
 * read as links, Back returns to the same place in the list, and the maps menu stays on screen.
 */
test("phone shell: pinned tab bar, underlined links, Back keeps the list position, maps menu on screen", async ({ agency, session }) => {
  for (let i = 0; i < 12; i++) await agency.detail({ title: `Beach access patrol ${agency.tag} ${i + 1}`, startAt: agencyAt(2 + i, 9) });
  const page = await session(agency.deputy, { viewport: PHONE });
  const bar = page.locator('[data-shell="tab-bar"]');

  await test.step("the tab bar is pinned to the bottom while the list scrolls", async () => {
    await page.goto("/jobs");
    await expect(page.getByRole("heading", { level: 1, name: "Details" })).toBeVisible();
    for (const scroll of [0, 1200]) {
      await page.evaluate((y) => document.getElementById("main")!.scrollTo({ top: y }), scroll);
      const box = await bar.boundingBox();
      expect(Math.round(box!.x)).toBe(0);
      expect(Math.round(box!.width)).toBe(PHONE.width);
      expect(Math.round(box!.y + box!.height)).toBe(PHONE.height);
    }
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });

  await test.step("text links are underlined", async () => {
    for (const path of ["/home", "/jobs", "/billing", "/profile"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect({ path, bare: await bareLinks(page) }).toEqual({ path, bare: [] });
    }
  });

  await test.step("Back from a detail returns to the same place in the list", async () => {
    await page.goto("/jobs");
    const target = page.getByRole("main").getByRole("link", { name: new RegExp(`Beach access patrol ${agency.tag} 12`) });
    await target.scrollIntoViewIfNeeded();
    const before = await mainTop(page);
    expect(before).toBeGreaterThan(100);
    await target.click();
    await expect(page.getByRole("link", { name: "Back to details" })).toBeVisible();
    expect(await bareLinks(page)).toEqual([]);
    await page.goBack();
    await expect(page).toHaveURL(/\/jobs$/);
    await expect.poll(() => mainTop(page)).toBeGreaterThan(before - 5);
    expect(await mainTop(page)).toBeLessThan(before + 5);
  });

  await test.step("the maps menu stays on screen", async () => {
    const row = page.getByRole("main").getByRole("listitem").filter({ hasText: `Beach access patrol ${agency.tag} 12` });
    await row.getByRole("button", { name: "Open in Maps" }).click();
    const menu = page.getByRole("group", { name: "Open with" });
    await expect(menu).toBeVisible();
    const box = await menu.boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(PHONE.width);
    expect(box!.y + box!.height).toBeLessThanOrEqual(PHONE.height);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBe(0);
    await expect(menu.getByRole("link", { name: /Google Maps/ })).toBeVisible();
    await expect(menu.getByRole("link", { name: /Apple Maps/ })).toBeVisible();
  });
});
