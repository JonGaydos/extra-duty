import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { E2E } from "./env";
import { signInAs } from "./session";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const THEMES = [
  { name: "day", colorScheme: "light", canvas: "rgb(244, 246, 248)" },
  { name: "night", colorScheme: "dark", canvas: "rgb(15, 19, 24)" },
] as const;

const tabBar = (page: Page) => page.locator('[data-shell="tab-bar"]');
const topNav = (page: Page) => page.locator('[data-shell="top-nav"]');
const canvas = (page: Page) => page.evaluate(() => getComputedStyle(document.body).backgroundColor);

async function expectNoSeriousA11yIssues(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

test("the web app manifest is served", async ({ request }) => {
  const res = await request.get("/manifest.webmanifest");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("manifest+json");
  const manifest = await res.json();
  expect(manifest).toMatchObject({ name: "Extra Duty", short_name: "Extra Duty", start_url: "/", display: "standalone" });
  const sizes = manifest.icons.map((i: { sizes: string }) => i.sizes);
  expect(sizes).toEqual(expect.arrayContaining(["192x192", "512x512"]));
  for (const icon of manifest.icons) expect((await request.get(icon.src)).status()).toBe(200);
});

test("the service worker script is served from the root scope", async ({ request }) => {
  const res = await request.get("/sw.js");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("javascript");
  const body = await res.text();
  expect(body).toContain("push");
  expect(body).toContain("notificationclick");
});

test("signed-out visitors go to sign-in, and the sign-in page still works", async ({ page }) => {
  await page.goto("/home");
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.getByLabel("Email")).toBeVisible();
});

for (const theme of THEMES) {
  test.describe(`${theme.name} theme`, () => {
    test.use({ colorScheme: theme.colorScheme });

    test("phone shows the bottom tab bar and no top nav", async ({ page, context }) => {
      await signInAs(context, "deputy");
      await page.setViewportSize(PHONE);
      await page.goto("/home");
      await expect(tabBar(page)).toBeVisible();
      await expect(topNav(page)).toBeHidden();
      await expect(tabBar(page).getByRole("link", { name: "Home" })).toHaveAttribute("aria-current", "page");
      expect(await canvas(page)).toBe(theme.canvas);
      await page.screenshot({ path: `${E2E.screenshotDir}/shell-phone-${theme.name}.png`, fullPage: true });
      await expectNoSeriousA11yIssues(page);
    });

    test("desktop shows the top nav and no tab bar", async ({ page, context }) => {
      await signInAs(context, "coordinator");
      await page.setViewportSize(DESKTOP);
      await page.goto("/coordinate");
      await expect(topNav(page)).toBeVisible();
      await expect(tabBar(page)).toBeHidden();
      await expect(topNav(page).getByRole("link", { name: "To-do" })).toHaveAttribute("aria-current", "page");
      expect(await canvas(page)).toBe(theme.canvas);
      await page.screenshot({ path: `${E2E.screenshotDir}/shell-desktop-${theme.name}.png`, fullPage: true });
      await expectNoSeriousA11yIssues(page);
    });
  });
}

test("the tab bar switches to the top nav at 768 px", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize({ width: 767, height: 900 });
  await page.goto("/home");
  await expect(tabBar(page)).toBeVisible();
  await expect(topNav(page)).toBeHidden();
  await page.setViewportSize({ width: 768, height: 900 });
  await expect(topNav(page)).toBeVisible();
  await expect(tabBar(page)).toBeHidden();
});

const NAV = {
  deputy: { start: "/home", desktop: ["Home", "Details", "Map", "Billing", "Profile"], phone: ["Home", "Details", "Map", "Billing", "Profile"] },
  coordinator: {
    start: "/coordinate",
    desktop: ["To-do", "Details", "Calendar", "Vendors", "Payments", "Reports", "Messages", "Management"],
    phone: ["To-do", "Details", "Calendar", "Messages", "More"],
  },
  admin: {
    start: "/coordinate",
    desktop: ["To-do", "Details", "Calendar", "Vendors", "Payments", "Reports", "Messages", "Management"],
    phone: ["To-do", "Details", "Calendar", "Messages", "More"],
  },
  vendor: {
    start: "/vendor",
    desktop: ["My details", "Request a detail", "Invoices", "Locations", "Contracts"],
    phone: ["My details", "Request", "Invoices", "Locations", "More"],
  },
} as const;

for (const [who, nav] of Object.entries(NAV) as [keyof typeof NAV, (typeof NAV)[keyof typeof NAV]][]) {
  test(`${who} navigation is role-aware and every item opens a page`, async ({ page, context }) => {
    await signInAs(context, who);
    await page.goto("/");
    await expect(page).toHaveURL(new RegExp(`${nav.start}$`));

    await page.setViewportSize(DESKTOP);
    const links = topNav(page).getByRole("navigation", { name: "Main" }).getByRole("link");
    await expect(links).toHaveText([...nav.desktop]);
    for (const name of nav.desktop) {
      await topNav(page).getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click();
      await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
      await expect(topNav(page).getByRole("link", { name, exact: true })).toHaveAttribute("aria-current", "page");
    }

    await page.setViewportSize(PHONE);
    await expect(tabBar(page).getByRole("link")).toHaveText([...nav.phone]);
  });
}

test("More lists the sections that do not fit in the tab bar", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/coordinate");
  await tabBar(page).getByRole("link", { name: "More" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "More" })).toBeVisible();
  await expect(tabBar(page).getByRole("link", { name: "More" })).toHaveAttribute("aria-current", "page");
  for (const name of ["Vendors", "Payments", "Reports", "Management", "Profile"]) {
    await expect(page.getByRole("main").getByRole("link", { name, exact: true })).toBeVisible();
  }
  await page.screenshot({ path: `${E2E.screenshotDir}/more-phone-day.png`, fullPage: true });
  await expectNoSeriousA11yIssues(page);
});

test.describe("theme override", () => {
  test.use({ colorScheme: "dark" });

  test("follows the device until toggled, then the cookie and profile keep the choice", async ({ page, context, browser }) => {
    await signInAs(context, "themeDeputy");
    await page.setViewportSize(DESKTOP);
    await page.goto("/home");
    expect(await canvas(page)).toBe("rgb(15, 19, 24)");

    const theme = topNav(page).getByRole("radiogroup", { name: "Theme" });
    await theme.getByRole("radio", { name: "Day" }).check();
    expect(await canvas(page)).toBe("rgb(244, 246, 248)");
    await expect.poll(async () => (await context.cookies()).find((c) => c.name === "ed-theme")?.value).toBe("day");

    // The server renders the override, so a reload never flashes the device theme.
    const html = await (await page.request.get("/home")).text();
    expect(html).toMatch(/<html[^>]*data-theme="day"/);
    await page.reload();
    expect(await canvas(page)).toBe("rgb(244, 246, 248)");
    await expect(theme.getByRole("radio", { name: "Day" })).toBeChecked();

    // A new device (no cookie) picks the choice up from the profile.
    const other = await browser.newContext({ colorScheme: "dark", viewport: DESKTOP });
    await signInAs(other, "themeDeputy");
    const otherPage = await other.newPage();
    await otherPage.goto("/home");
    expect(await canvas(otherPage)).toBe("rgb(244, 246, 248)");
    await other.close();

    // Back to System follows the device again.
    await theme.getByRole("radio", { name: "System" }).check();
    expect(await canvas(page)).toBe("rgb(15, 19, 24)");
    await expect.poll(async () => (await context.cookies()).find((c) => c.name === "ed-theme")).toBeUndefined();
    await page.reload();
    expect(await canvas(page)).toBe("rgb(15, 19, 24)");
  });

  test("the phone profile page carries the theme control", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.setViewportSize(PHONE);
    await page.goto("/profile");
    await expect(page.getByRole("main").getByRole("radiogroup", { name: "Theme" })).toBeVisible();
    await page.screenshot({ path: `${E2E.screenshotDir}/profile-phone-night.png`, fullPage: true });
    await expectNoSeriousA11yIssues(page);
  });
});

test("an offline navigation shows the offline page", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.goto("/home");
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.reload(); // the page is now controlled by the service worker
  await context.setOffline(true);
  await page.goto("/billing").catch(() => undefined);
  await expect(page.getByRole("heading", { name: "You are offline" })).toBeVisible();
  await context.setOffline(false);
});

test.describe("phone current tab", () => {
  test.use({ viewport: PHONE });

  const current = (page: Page) => tabBar(page).locator('[aria-current="page"]');

  test("a coordinator on Payments sees More as current, not To-do", async ({ page, context }) => {
    await signInAs(context, "coordinator");
    await page.goto("/coordinate/payments");
    await expect(current(page)).toHaveText(["More"]);
    await page.goto("/coordinate");
    await expect(current(page)).toHaveText(["To-do"]);
  });

  test("a vendor on Contracts sees More as current, not My details", async ({ page, context }) => {
    await signInAs(context, "vendor");
    await page.goto("/vendor/contracts");
    await expect(current(page)).toHaveText(["More"]);
  });

  test("a deputy on Profile sees Profile as current", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/profile");
    await expect(current(page)).toHaveText(["Profile"]);
  });

  test("deputies have no More page", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/more");
    await expect(page).toHaveURL(/\/home$/);
  });
});

test.describe("signing out", () => {
  test("a signed-in person who opens sign-in goes to their start page", async ({ page, context }) => {
    await signInAs(context, "vendor");
    await page.goto("/sign-in");
    await expect(page).toHaveURL(/\/vendor$/);
  });

  test("a failed sign-out keeps the person on Profile and says so", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/profile");
    await page.route("**/api/auth/sign-out", (route) => route.fulfill({ status: 500, body: "{}" }));
    await page.getByRole("main").getByRole("button", { name: "Sign out" }).click();
    await expect(page.getByRole("main").getByRole("alert")).toHaveText(
      "Could not sign you out. Check your connection and try again.",
    );
    await expect(page).toHaveURL(/\/profile$/);
    await expect(page.getByRole("main").getByRole("button", { name: "Sign out" })).toBeEnabled();
  });

  test("signing out ends the session", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/profile");
    await page.getByRole("main").getByRole("button", { name: "Sign out" }).click();
    await expect(page).toHaveURL(/\/sign-in$/);
    await page.goto("/home");
    await expect(page).toHaveURL(/\/sign-in$/);
  });
});

test.describe("header theme control", () => {
  test.use({ colorScheme: "dark", viewport: DESKTOP });

  test("a failed save says so and leaves the theme as it was", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/home");
    await page.route("**/api/v1/me/theme", (route) => route.fulfill({ status: 500, body: "{}" }));
    const theme = topNav(page).getByRole("radiogroup", { name: "Theme" });
    await theme.getByRole("radio", { name: "Day" }).click();
    await expect(topNav(page).getByRole("alert")).toContainText("Your theme could not be saved");
    expect(await canvas(page)).toBe("rgb(15, 19, 24)");
    await expect(theme.getByRole("radio", { name: "System" })).toBeChecked();
    expect((await context.cookies()).find((c) => c.name === "ed-theme")).toBeUndefined();
    await page.screenshot({ path: `${E2E.screenshotDir}/theme-save-error-desktop-night.png` });
    await expectNoSeriousA11yIssues(page);

    // The note closes on Escape and on a click outside it.
    await page.keyboard.press("Escape");
    await expect(topNav(page).getByRole("alert")).toBeHidden();
    await theme.getByRole("radio", { name: "Night" }).click();
    await expect(topNav(page).getByRole("alert")).toBeVisible();
    await page.getByRole("main").click();
    await expect(topNav(page).getByRole("alert")).toBeHidden();
  });

  test("the browser chrome color follows the chosen theme", async ({ page, context }) => {
    await signInAs(context, "deputy");
    await page.goto("/home");
    const darkMeta = page.locator('meta[name="theme-color"][media*="dark"]');
    await expect(darkMeta).toHaveAttribute("content", "#0f1318");
    await topNav(page).getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Day" }).check();
    await expect(darkMeta).toHaveAttribute("content", "#f4f6f8");
    // The cookie is written once the profile has saved the choice.
    await expect.poll(async () => (await context.cookies()).find((c) => c.name === "ed-theme")?.value).toBe("day");
    const html = await (await page.request.get("/home")).text();
    expect(html).toMatch(/<meta name="theme-color" media="\(prefers-color-scheme: dark\)" content="#f4f6f8"/);
    await topNav(page).getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "System" }).check();
    await expect(darkMeta).toHaveAttribute("content", "#0f1318");
  });
});

test("the theme endpoint accepts day, night or system and rejects anything else", async ({ page, context }) => {
  await signInAs(context, "themeDeputy");
  await page.goto("/profile");
  for (const theme of ["sepia", null, 3]) {
    const res = await page.request.put("/api/v1/me/theme", { data: { theme } });
    expect(res.status()).toBe(400);
  }
  for (const theme of ["night", "system"]) {
    const res = await page.request.put("/api/v1/me/theme", { data: { theme } });
    expect(res.status()).toBe(200);
  }
});

const AUTH_PAGES = [
  { path: "/sign-in", heading: "Sign in", shot: "sign-in" },
  { path: "/two-factor", heading: "Enter your sign-in code", shot: "two-factor" },
  { path: "/forgot-password", heading: "Reset your password", shot: "forgot-password" },
  { path: "/reset-password?token=e2e", heading: "Set a new password", shot: "reset-password" },
  { path: "/reset-password", heading: "Set a new password", shot: "reset-password-invalid" },
  { path: "/accept-invite?token=e2e", heading: "Set up your account", shot: "accept-invite" },
  { path: "/accept-invite", heading: "Set up your account", shot: "accept-invite-invalid" },
] as const;

for (const theme of THEMES) {
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    test(`signed-out pages in ${theme.name} at ${size} size are styled and accessible`, async ({ browser }) => {
      const context = await browser.newContext({ colorScheme: theme.colorScheme, viewport });
      const page = await context.newPage();
      for (const p of AUTH_PAGES) {
        await page.goto(p.path);
        await expect(page.getByRole("heading", { level: 1, name: p.heading })).toBeVisible();
        await expect(page.getByText("Bayside County Sheriff's Office")).toBeVisible();
        expect(await canvas(page)).toBe(theme.canvas);
        if (p.path === "/sign-in" || p.path === "/two-factor") {
          await page.screenshot({ path: `${E2E.screenshotDir}/${p.shot}-${size}-${theme.name}.png`, fullPage: true });
        }
        await expectNoSeriousA11yIssues(page);
      }
      await context.close();
    });
  }
}

test("the sign-in page matches the approved copy and field sizes", async ({ page }) => {
  await page.setViewportSize(PHONE);
  await page.goto("/sign-in");
  await expect(page.getByText("After your password, we email you a 6-digit code to finish signing in.")).toBeVisible();
  await expect(
    page.getByText(
      "Accounts not signed in within the past 3 months require a password reset. Use Forgot password to reset it yourself.",
    ),
  ).toBeVisible();
  for (const label of ["Email", "Password"]) {
    expect((await page.getByLabel(label).boundingBox())?.height).toBe(48);
  }
  const button = await page.getByRole("button", { name: "Sign in" }).boundingBox();
  const field = await page.getByLabel("Email").boundingBox();
  expect(button?.width).toBe(field?.width);
});

test("the two-factor code field is one numeric one-time-code input", async ({ page }) => {
  await page.goto("/two-factor");
  const code = page.getByLabel("Code");
  await expect(code).toHaveAttribute("inputmode", "numeric");
  await expect(code).toHaveAttribute("autocomplete", "one-time-code");
  await expect(code).toHaveAttribute("maxlength", "6");
});
