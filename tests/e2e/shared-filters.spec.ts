import { expect, test, type Page } from "@playwright/test";
import { FIXTURE } from "./personnel-fixtures";
import { signInAs } from "./session";

/**
 * List, Calendar and Map share one filter panel and one set of filters: set in one view, carried in the address to
 * the others, and remembered as one set.
 */

const DESKTOP = { width: 1280, height: 900 };
const panel = (page: Page) => page.getByRole("complementary", { name: "Filters" });
const views = (page: Page) => page.getByRole("navigation", { name: "Details views" });

/** The panel's state: what a person would read off it. */
async function panelState(page: Page) {
  const p = panel(page);
  return {
    q: await p.getByLabel("Search").inputValue(),
    flex: await p.getByLabel("Flexible times").isChecked(),
    open: await p.getByLabel("Open spots only").isChecked(),
    mine: await p.getByLabel("My details only").isChecked(),
  };
}

const shows = (page: Page, title: string) => page.getByRole("main").getByText(title, { exact: false }).first();

test("filters set in List carry to Calendar and Map, with the same results and the same panel", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(DESKTOP);
  await page.goto("/jobs?f=1");
  await panel(page).getByLabel("Flexible times").check();
  await panel(page).getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/flex=1/);
  await expect(shows(page, FIXTURE.flexJob)).toBeVisible();
  await expect(page.getByRole("main").getByText(FIXTURE.openJob)).toHaveCount(0);
  const state = await panelState(page);
  expect(state).toEqual({ q: "", flex: true, open: false, mine: false });
  // Sort applies to the List only.
  await expect(panel(page).getByLabel("Sort by")).toBeVisible();

  await views(page).getByRole("link", { name: "Calendar" }).click();
  await expect(page).toHaveURL(/\/calendar\?.*flex=1/);
  expect(await panelState(page)).toEqual(state);
  await expect(panel(page).getByLabel("Sort by")).toHaveCount(0);
  // The Calendar's list range shows the same details as the List.
  await page.getByRole("navigation", { name: "Calendar range" }).getByRole("link", { name: "List" }).click();
  await expect(page).toHaveURL(/flex=1/);
  await expect(shows(page, FIXTURE.flexJob)).toBeVisible();
  await expect(page.getByRole("main").getByText(FIXTURE.openJob)).toHaveCount(0);

  await views(page).getByRole("link", { name: "Map" }).click();
  await expect(page).toHaveURL(/\/map\?.*flex=1/);
  expect(await panelState(page)).toEqual(state);
  await expect(page.getByRole("list", { name: "Details on the map" }).getByText(FIXTURE.flexJob)).toBeVisible();
  await expect(page.getByRole("list", { name: "Details on the map" }).getByText(FIXTURE.openJob)).toHaveCount(0);

  await views(page).getByRole("link", { name: "List" }).click();
  await expect(page).toHaveURL(/\/jobs\?.*flex=1/);
  expect(await panelState(page)).toEqual(state);
});

test("Remember my filters keeps one set for every view, and Reset clears it", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(DESKTOP);
  await page.goto("/calendar?f=1");
  await panel(page).getByLabel("Flexible times").check();
  await panel(page).getByLabel("Remember my filters").check();
  await panel(page).getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/flex=1/);

  // Plain visits to each view use the one remembered set.
  for (const path of ["/jobs", "/calendar", "/map"]) {
    await page.goto(path);
    expect(await panelState(page), path).toMatchObject({ flex: true });
    await expect(panel(page).getByLabel("Remember my filters"), path).toBeChecked();
  }
  await page.goto("/jobs");
  await expect(page.getByRole("main").getByText(FIXTURE.openJob)).toHaveCount(0);

  await page.goto("/map");
  await panel(page).getByRole("button", { name: "Reset" }).click();
  await expect(page).toHaveURL(/\/map\?f=1$/);
  await page.goto("/jobs");
  expect(await panelState(page)).toMatchObject({ flex: false });
  await expect(shows(page, FIXTURE.openJob)).toBeVisible();
});

test("on a phone the Map's filters are the same panel, behind the Filters button", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/map?f=1");
  await expect(panel(page).getByLabel("Search")).toBeHidden();
  await panel(page).getByRole("button", { name: "Filters" }).click();
  await expect(panel(page).getByLabel("Search")).toBeVisible();
  await expect(panel(page).getByLabel("Open spots only")).toBeVisible();
});
