import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { COORD } from "./coordinator-fixtures";
import { E2E } from "./env";
import { signInAs } from "./session";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const PINE_HARBOR = "12615 US 1, Pine Harbor, FL 32401";

async function expectNoSeriousA11yIssues(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}

type Loc = { address: string; lat: number | null; lng: number | null; geocode_source: string };
const location = async (name: string) => (await rows<Loc>("select address, lat, lng, geocode_source from vendor_locations where name = $1", [name]))[0];

test.beforeEach(async ({ page }) => {
  // Map tiles come from an outside server; the suite never depends on it.
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
});

/** Opens the vendor's new location form and types an address, leaving the field so it is looked up. */
async function newLocation(page: Page, name: string, address: string) {
  await page.goto("/vendor/locations");
  await page.getByRole("button", { name: "Add a location" }).click();
  await page.getByLabel("Location name").fill(name);
  await page.getByLabel("Address", { exact: true }).fill(address);
  await page.getByLabel("Site notes").click();
}

test("a different match is offered; Use suggested fills it in and stores its pin", async ({ page, context }) => {
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await newLocation(page, "Pine Harbor lot", "12615 US-1 Pine Harbor");
  await expect(page.getByText(`Did you mean ${PINE_HARBOR}`)).toBeVisible();
  await expect(page.getByRole("status").getByRole("link", { name: "OpenStreetMap" })).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  await page.screenshot({ path: `${E2E.screenshotDir}/address-suggestion-phone.png`, fullPage: true });
  await page.getByRole("button", { name: "Use suggested" }).click();
  await expect(page.getByLabel("Address", { exact: true })).toHaveValue(PINE_HARBOR);
  await expect(page.getByText("Found on the map.")).toBeVisible();
  await expect(page.getByTestId("pin-map")).toBeVisible();
  await page.getByRole("button", { name: "Add location" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Location added." })).toBeVisible();
  expect(await location("Pine Harbor lot")).toEqual({ address: PINE_HARBOR, lat: 29.4987, lng: -82.1361, geocode_source: "auto" });
});

test("Keep as entered and no match both show Not verified and save as typed with no pin", async ({ page, context }) => {
  await signInAs(context, "vendor");
  await page.setViewportSize(DESKTOP);
  await newLocation(page, "Typed lot", "12615 US-1 Pine Harbor");
  await page.getByRole("button", { name: "Keep as entered" }).click();
  await expect(page.getByText("Not verified")).toBeVisible();
  await expect(page.getByLabel("Address", { exact: true })).toHaveValue("12615 US-1 Pine Harbor");
  await page.getByRole("button", { name: "Add location" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Location added." })).toBeVisible();
  expect(await location("Typed lot")).toMatchObject({ address: "12615 US-1 Pine Harbor", lat: null, lng: null });

  await newLocation(page, "Unknown lot", "1 Nowhere Lane, Pine Harbor");
  await expect(page.getByText("Not verified")).toBeVisible();
  await expect(page.getByText("Saved as typed. Check it before deputies rely on it.")).toBeVisible();
  await page.screenshot({ path: `${E2E.screenshotDir}/address-not-verified-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Add location" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Location added." })).toBeVisible();
  expect(await location("Unknown lot")).toMatchObject({ address: "1 Nowhere Lane, Pine Harbor", lat: null });
});

test("a failing geocoder never blocks saving", async ({ page, context }) => {
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await newLocation(page, "Broken lot", "99 Broken Road, Pine Harbor");
  await expect(page.getByText("The address lookup did not answer. It saves as typed.")).toBeVisible();
  await page.getByRole("button", { name: "Add location" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Location added." })).toBeVisible();
  expect(await location("Broken lot")).toMatchObject({ address: "99 Broken Road, Pine Harbor", lat: null });

  // Offline: the lookup request itself fails, and the deputy's mailing address still saves.
  await signInAs(context, "deputy");
  await page.route("**/api/v1/geocode**", (r) => r.abort());
  await page.goto("/profile");
  const field = page.getByLabel("Mailing address");
  await field.fill("PO Box 77, Pine Harbor, FL 32401");
  await page.getByLabel("Phone", { exact: true }).click();
  await expect(page.getByText("Not verified")).toBeVisible();
  await page.getByRole("button", { name: "Save contact details" }).click();
  await expect(page.getByRole("status").filter({ hasText: /saved/i })).toBeVisible();
  expect(await rows("select mailing_address from users where email = 'deputy@e2e.test'")).toEqual([{ mailing_address: "PO Box 77, Pine Harbor, FL 32401" }]);
});

test("a safety address pin can be dragged, and the stored point overrides the lookup", async ({ page, context }) => {
  const [job] = await rows<{ id: string }>("select id from jobs where title = $1 order by start_at limit 1", [COORD.opsJob]);
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto(`/coordinate/details/${job.id}`);
  await page.getByRole("button", { name: /(Add|Edit) officer safety/ }).click();
  const form = page.getByRole("form", { name: "Officer safety" });
  await form.getByRole("button", { name: /Add (an|another) address/ }).click();
  const field = form.getByLabel(/^Address of concern \d+$/).last();
  await field.fill(PINE_HARBOR);
  await form.getByLabel("What to know").last().fill("Loose dog in the yard");
  await expect(form.getByText("Found on the map.")).toBeVisible();
  const pin = form.getByTestId("pin-map").last().locator(".ed-pin-label");
  await expect(pin).toBeVisible();
  await form.getByTestId("pin-map").last().scrollIntoViewIfNeeded();
  const box = (await pin.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 40, { steps: 8 });
  await page.mouse.up();
  await expect(form.getByText("Pin placed by hand. It is used instead of the address lookup.")).toBeVisible();
  // The pin also moves from the keyboard.
  await form.getByTestId("pin-map").last().locator(".leaflet-marker-icon").focus();
  await page.keyboard.press("ArrowUp");
  await page.screenshot({ path: `${E2E.screenshotDir}/address-pin-desktop.png`, fullPage: true });
  await form.getByRole("button", { name: "Save officer safety" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Officer safety saved." })).toBeVisible();
  const [saved] = await rows<{ lat: number; lng: number; description: string }>("select lat, lng, description from job_safety_addresses where job_id = $1 and address = $2", [job.id, PINE_HARBOR]);
  // The description typed while the address was being looked up is kept.
  expect(saved.description).toBe("Loose dog in the yard");
  // Strictly below and above the looked-up point, so the pin moved.
  expect(saved.lat).toBeLessThan(29.4987);
  expect(saved.lng).toBeGreaterThan(-82.1361);
});
