import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E } from "./env";
import { signInAs } from "./session";

/**
 * The phone app shell (Task 39c): a flush tab bar that never overlaps content, a document that never scrolls (so
 * Firefox Android keeps its toolbar) and a main region that scrolls on its own. Runs in Chromium, and in Firefox
 * when E2E_FIREFOX is set.
 */
const PHONE = { width: 390, height: 844 };
const THEMES = [
  { name: "day", colorScheme: "light" },
  { name: "night", colorScheme: "dark" },
] as const;

const tabBar = (page: Page) => page.locator('[data-shell="tab-bar"]');

async function expectNoSeriousA11yIssues(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

/** Main scrolled to its end: the last thing in it must sit above the tab bar, not behind it. */
async function lastItemClearsTabBar(page: Page) {
  return page.evaluate(() => {
    const main = document.getElementById("main")!;
    main.scrollTop = main.scrollHeight;
    const last = main.lastElementChild!.getBoundingClientRect();
    const bar = document.querySelector('[data-shell="tab-bar"]')!.getBoundingClientRect();
    return { lastBottom: Math.round(last.bottom), barTop: Math.round(bar.top) };
  });
}

for (const theme of THEMES) {
  test.describe(`phone app shell, ${theme.name}`, () => {
    test.use({ colorScheme: theme.colorScheme, viewport: PHONE });

    for (const [who, path] of [
      ["deputy", "/profile"],
      ["coordinator", "/coordinate/details"],
      ["vendor", "/vendor/request"],
    ] as const) {
      test(`${who} on ${path}: flush tab bar, the document stays put and main scrolls`, async ({ page, context, browserName }) => {
        await signInAs(context, who);
        await page.goto(path);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();

        const bar = await tabBar(page).boundingBox();
        expect(bar).not.toBeNull();
        expect(Math.round(bar!.x)).toBe(0);
        expect(Math.round(bar!.width)).toBe(PHONE.width);
        expect(Math.round(bar!.y + bar!.height)).toBe(PHONE.height);
        const style = await tabBar(page).evaluate((el) => {
          const s = getComputedStyle(el);
          return { radius: s.borderTopLeftRadius, shadow: s.boxShadow, top: s.borderTopWidth, position: s.position };
        });
        expect(style).toEqual({ radius: "0px", shadow: "none", top: "1px", position: "static" });

        // The document never scrolls; main does.
        const doc = await page.evaluate(() => {
          window.scrollTo(0, 2000);
          const el = document.scrollingElement!;
          return { scrollY: window.scrollY, overflow: el.scrollHeight - el.clientHeight };
        });
        expect(doc).toEqual({ scrollY: 0, overflow: 0 });
        const main = await page.evaluate(() => {
          const m = document.getElementById("main")!;
          return { scrolls: m.scrollHeight > m.clientHeight, overflowY: getComputedStyle(m).overflowY };
        });
        expect(main).toEqual({ scrolls: true, overflowY: "auto" });

        const { lastBottom, barTop } = await lastItemClearsTabBar(page);
        expect(lastBottom).toBeLessThanOrEqual(barTop);

        await page.screenshot({ path: `${E2E.screenshotDir}/app-shell-${who}-${browserName}-${theme.name}.png` });
        await expectNoSeriousA11yIssues(page);
      });
    }
  });
}

/** Anchors in main that are not underlined, other than button-styled links, nav items and card links that underline their title. */
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

test.describe("links read as links", () => {
  test.use({ viewport: PHONE });

  test("deputy pages: every text link in main is underlined", async ({ page, context }) => {
    await signInAs(context, "deputy");
    for (const path of ["/home", "/jobs", "/billing", "/messages", "/profile", "/alerts"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect({ path, bare: await bareLinks(page) }).toEqual({ path, bare: [] });
    }
    await page.goto("/jobs");
    await page.getByRole("link", { name: /Coastal Line Clearing/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await bareLinks(page)).toEqual([]);
  });

  test("vendor pages: every text link in main is underlined", async ({ page, context }) => {
    await signInAs(context, "vendor");
    for (const path of ["/vendor", "/vendor?view=calendar", "/vendor/request", "/vendor/invoices", "/vendor/locations", "/vendor/contracts", "/more"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect({ path, bare: await bareLinks(page) }).toEqual({ path, bare: [] });
    }
    await page.goto("/vendor");
    await page.getByRole("main").getByRole("link", { name: /Town Center gate/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    expect(await bareLinks(page)).toEqual([]);
  });

  test("coordinator pages: every text link in main is underlined", async ({ page, context }) => {
    await signInAs(context, "coordinator");
    for (const path of ["/coordinate", "/coordinate/details", "/coordinate/vendors", "/coordinate/payments", "/coordinate/reports", "/coordinate/reports/activity", "/calendar", "/more"]) {
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      expect({ path, bare: await bareLinks(page) }).toEqual({ path, bare: [] });
    }
  });
});

const FLEX_JOB = "Right-of-way clearing";

async function sql<T = Record<string, unknown>>(text: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    return (await client.query(text, params)).rows as T[];
  } finally {
    await client.end();
  }
}

test.describe("addresses, maps and the site contact", () => {
  test.use({ viewport: PHONE });

  test("Open in Maps offers three apps, remembers a choice, and Profile can go back to asking", async ({ page, context }) => {
    await signInAs(context, "themeDeputy");
    const [job] = await sql<{ id: string }>("select id from jobs where title = $1", [FLEX_JOB]);
    await page.goto(`/jobs/${job.id}`);
    const meet = page.getByRole("main").getByRole("button", { name: "Open in Maps" }).first();
    await expect(meet).toHaveAttribute("aria-expanded", "false");
    await meet.click();
    await expect(meet).toHaveAttribute("aria-expanded", "true");
    const menu = page.getByRole("group", { name: "Open with" });
    await expect(menu.getByRole("link", { name: /Google Maps/ })).toHaveAttribute("href", "https://www.google.com/maps/search/?api=1&query=29.4988%2C-82.1361");
    await expect(menu.getByRole("link", { name: /Apple Maps/ })).toHaveAttribute("href", /^https:\/\/maps\.apple\.com\/\?q=350%20Industrial%20Dr.*&ll=29\.4988,-82\.1361$/);
    await expect(menu.getByRole("link", { name: /OpenStreetMap/ })).toHaveAttribute("href", "https://www.openstreetmap.org/?mlat=29.4988&mlon=-82.1361#map=17/29.4988/-82.1361");
    for (const l of await menu.getByRole("link").all()) await expect(l).toHaveAttribute("target", "_blank");
    await page.screenshot({ path: `${E2E.screenshotDir}/maps-menu-phone.png` });
    await expectNoSeriousA11yIssues(page);

    await menu.getByLabel("Remember my choice").check();
    const popup = page.waitForEvent("popup");
    await page.route("https://maps.apple.com/**", (r) => r.fulfill({ status: 200, body: "ok" }));
    await menu.getByRole("link", { name: /Apple Maps/ }).click();
    await (await popup).close();
    // The choice is saved: the link opens Apple Maps directly, with Other maps beside it.
    await expect.poll(async () => (await sql<{ app: string | null }>("select preferred_maps_app as app from users where email = 'theme@e2e.test'"))[0].app).toBe("apple");
    await page.reload();
    await expect(page.getByRole("main").getByRole("link", { name: /Open in Maps with Apple Maps/ }).first()).toHaveAttribute("href", /maps\.apple\.com/);
    await expect(page.getByRole("main").getByRole("button", { name: "Other maps" }).first()).toBeVisible();

    await page.goto("/profile");
    const maps = page.getByRole("main").locator("#maps");
    await expect(maps.getByRole("radio", { name: "Apple Maps" })).toBeChecked();
    await maps.getByRole("radio", { name: "Ask each time" }).check();
    await expect.poll(async () => (await sql<{ app: string | null }>("select preferred_maps_app as app from users where email = 'theme@e2e.test'"))[0].app).toBeNull();
  });

  test("the site contact is a name and a tel: link; a bad saved number shows as typed, flagged to staff only", async ({ page, context, browser }) => {
    const [job] = await sql<{ id: string; contact_name: string; contact_phone: string }>("select id, contact_name, contact_phone from jobs where title = $1", [FLEX_JOB]);
    await signInAs(context, "deputy");
    await page.goto(`/jobs/${job.id}`);
    const contact = page.getByRole("main").getByRole("definition").filter({ hasText: "Rowan Fairley" });
    await expect(contact.getByRole("link", { name: "850-555-0199" })).toHaveAttribute("href", "tel:+18505550199");
    await expect(contact.locator("svg")).toHaveCount(1);

    await sql("update jobs set contact_name = '123', contact_phone = '13' where id = $1", [job.id]);
    try {
      await page.reload();
      const bad = page.getByRole("main").getByRole("definition").filter({ hasText: "123" });
      await expect(bad).toContainText("13");
      await expect(bad.getByRole("link")).toHaveCount(0);
      await expect(bad).not.toContainText("Check this number");

      const staff = await browser.newContext({ viewport: PHONE });
      await signInAs(staff, "coordinator");
      const sp = await staff.newPage();
      await sp.goto(`/coordinate/details/${job.id}`);
      await expect(sp.getByRole("main").getByText("Check this number")).toBeVisible();
      await sp.screenshot({ path: `${E2E.screenshotDir}/contact-check-number-phone.png` });
      await staff.close();
    } finally {
      await sql("update jobs set contact_name = $2, contact_phone = $3 where id = $1", [job.id, job.contact_name, job.contact_phone]);
    }
  });
});

for (const theme of THEMES) {
  test.describe(`staff pages, ${theme.name}`, () => {
    test.use({ colorScheme: theme.colorScheme });

    for (const [size, viewport] of [["phone", PHONE], ["desktop", { width: 1280, height: 900 }]] as const) {
      test(`personnel activity and a detail's deputy list at ${size} size are accessible`, async ({ page, context }) => {
        await page.setViewportSize(viewport);
        await signInAs(context, "coordinator");
        await page.goto("/coordinate/reports/activity");
        await expect(page.getByRole("heading", { level: 1, name: "Personnel activity" })).toBeVisible();
        await expect(page.getByRole("heading", { name: /^Top five/ })).toBeVisible();
        await expect(page.getByRole("table")).toBeVisible();
        // Sortable headers say which way they sort.
        await page.getByRole("button", { name: "Sign-ups" }).click();
        await expect(page.getByRole("columnheader", { name: "Sign-ups" })).toHaveAttribute("aria-sort", "descending");
        await page.screenshot({ path: `${E2E.screenshotDir}/activity-${size}-${theme.name}.png`, fullPage: size === "desktop" });
        await expectNoSeriousA11yIssues(page);

        const [job] = await sql<{ id: string }>("select id from jobs where title = $1", [FLEX_JOB]);
        await page.goto(`/coordinate/details/${job.id}`);
        await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
        await page.screenshot({ path: `${E2E.screenshotDir}/detail-staff-${size}-${theme.name}.png`, fullPage: size === "desktop" });
        await expectNoSeriousA11yIssues(page);
      });
    }
  });
}

/** The maps menu's right edge and main's sideways overflow, after opening it. */
async function menuFits(page: Page) {
  return page.evaluate(() => {
    const menu = document.querySelector('fieldset[aria-label="Open with"]')!.getBoundingClientRect();
    const main = document.getElementById("main")!;
    return { right: Math.round(menu.right), left: Math.round(menu.left), sideways: main.scrollWidth - main.clientWidth };
  });
}

test.describe("maps menu and scroll position on a phone", () => {
  test.use({ viewport: PHONE });

  test("the maps menu stays on screen from a /jobs row and from the map pin card", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/jobs");
    const row = page.getByRole("main").getByRole("button", { name: "Open in Maps" }).first();
    await row.click();
    const fits = await menuFits(page);
    expect(fits.right).toBeLessThanOrEqual(PHONE.width);
    expect(fits.left).toBeGreaterThanOrEqual(0);
    expect(fits.sideways).toBe(0);
    await page.screenshot({ path: `${E2E.screenshotDir}/maps-menu-job-row-phone.png` });

    await page.goto("/map");
    // Town center patrol: a pinned location with an address. (Harbor dock watch, at the same place and price, has a pin too.)
    await page.getByRole("region", { name: "Map of details" }).getByRole("button", { name: "$280 at $70/hr" }).first().click();
    // The chosen pin's card (the list of details below the map has its own Open in Maps buttons).
    await page.locator('#main output[aria-live="polite"]').getByRole("button", { name: "Open in Maps" }).click();
    const pin = await menuFits(page);
    expect(pin.right).toBeLessThanOrEqual(PHONE.width);
    expect(pin.left).toBeGreaterThanOrEqual(0);
    expect(pin.sideways).toBe(0);
  });

  test("a remembered maps choice that fails to save goes back to asking and says so", async ({ page, context }) => {
    await signInAs(context, "themeDeputy");
    await page.route("**/api/v1/me/maps-app", (r) => r.fulfill({ status: 500, body: "{}" }));
    await page.route("https://www.google.com/**", (r) => r.fulfill({ status: 200, body: "ok" }));
    const [job] = await sql<{ id: string }>("select id from jobs where title = $1", [FLEX_JOB]);
    await page.goto(`/jobs/${job.id}`);
    await page.getByRole("main").getByRole("button", { name: "Open in Maps" }).first().click();
    const menu = page.getByRole("group", { name: "Open with" });
    await menu.getByLabel("Remember my choice").check();
    const popup = page.waitForEvent("popup");
    await menu.getByRole("link", { name: /Google Maps/ }).click();
    await (await popup).close();
    await expect(page.getByRole("main").getByText("Your maps choice could not be saved. It will ask again next time.")).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Open in Maps" }).first()).toBeVisible();
    await expect(page.getByRole("main").getByRole("button", { name: "Other maps" })).toHaveCount(0);
  });

  for (const path of ["/jobs", "/home"]) {
    test(`Back from a detail returns to the same place on ${path}`, async ({ page, context }) => {
      await signInAs(context, "deputy");
      await page.goto(path);
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      const target = page.getByRole("main").locator('a[href^="/jobs/"]').last();
      await target.scrollIntoViewIfNeeded();
      const before = await page.evaluate(() => document.getElementById("main")!.scrollTop);
      expect(before).toBeGreaterThan(100);
      await target.click();
      await expect(page).toHaveURL(/\/jobs\/[^/]+$/);
      await expect(page.getByRole("link", { name: "Back to details" })).toBeVisible();
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${path.replace("/", "\\/")}$`));
      await expect.poll(() => page.evaluate(() => document.getElementById("main")!.scrollTop)).toBeGreaterThan(before - 5);
      expect(await page.evaluate(() => document.getElementById("main")!.scrollTop)).toBeLessThan(before + 5);
    });
  }
});

/** main's scroll position, and a client-side push through Next's router (as the filters do). */
const mainTop = (page: Page) => page.evaluate(() => Math.round(document.getElementById("main")!.scrollTop));
const push = (page: Page, url: string) => page.evaluate((u) => (window as unknown as { next: { router: { push: (u: string) => void } } }).next.router.push(u), url);
const settle = (page: Page) => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 50)))));

test.describe("scroll memory with filters, history moves and the skip link", () => {
  test.use({ viewport: PHONE });

  /** Leaves a remembered position on a detail page, so a wrong restore would show. */
  async function rememberDetail(page: Page): Promise<string> {
    await page.goto("/jobs");
    const href = (await page.getByRole("main").locator('a[href^="/jobs/"]').first().getAttribute("href"))!;
    await page.goto(href);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await page.evaluate(() => document.getElementById("main")!.scrollTo({ top: 400 }));
    await settle(page);
    expect(await mainTop(page)).toBeGreaterThan(300);
    return href;
  }

  test("Back to a filtered /jobs restores the position", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/jobs");
    await push(page, "/jobs?q=a");
    await expect(page).toHaveURL(/\/jobs\?q=a$/);
    const target = page.getByRole("main").locator('a[href^="/jobs/"]').last();
    await target.scrollIntoViewIfNeeded();
    await settle(page);
    const before = await mainTop(page);
    expect(before).toBeGreaterThan(100);
    await target.click();
    await expect(page.getByRole("link", { name: "Back to details" })).toBeVisible();
    await page.goBack();
    await expect(page).toHaveURL(/\/jobs\?q=a$/);
    await expect.poll(() => mainTop(page)).toBeGreaterThan(before - 5);
    expect(await mainTop(page)).toBeLessThan(before + 5);
  });

  test("after Back and Forward between two filtered /jobs entries, a link tap opens at the top", async ({ page, context }) => {
    await signInAs(context, "deputy");
    const href = await rememberDetail(page);
    await page.goto("/jobs");
    await push(page, "/jobs?q=a");
    await expect(page).toHaveURL(/q=a$/);
    await push(page, "/jobs?q=e");
    await expect(page).toHaveURL(/q=e$/);
    await page.goBack();
    await expect(page).toHaveURL(/q=a$/);
    await page.goForward();
    await expect(page).toHaveURL(/q=e$/);
    await settle(page);
    await page.getByRole("main").locator(`a[href="${href}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await settle(page);
    await settle(page);
    expect(await mainTop(page)).toBeLessThan(10);
  });

  test("after Skip to content, a link tap opens at the top", async ({ page, context }) => {
    await signInAs(context, "deputy");
    const href = await rememberDetail(page);
    await page.goto("/jobs");
    await page.keyboard.press("Tab");
    await expect(page.getByRole("link", { name: "Skip to content" })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/jobs#main$/);
    await settle(page);
    await page.getByRole("main").locator(`a[href="${href}"]`).first().click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await settle(page);
    await settle(page);
    expect(await mainTop(page)).toBeLessThan(10);
  });
});
