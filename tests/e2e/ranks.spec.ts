import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { E2E } from "./env";
import { signInAs } from "./session";

/** The Ranks page: highest first, add, rename, in and out of the ladder with a confirm step, and delete only when unused. */

async function audits(action: string, name: string): Promise<number> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    const { rows } = await client.query<{ n: string }>("select count(*) as n from audit_log where action = $1 and (before::text like $2 or after::text like $2)", [action, `%${name}%`]);
    return Number(rows[0].n);
  } finally {
    await client.end();
  }
}

const ladder = (page: Page) => page.getByRole("list", { name: "Ladder, highest first" });
const outside = (page: Page) => page.getByRole("list", { name: "Outside the ladder" });
const names = async (page: Page) => (await ladder(page).getByRole("listitem").allInnerTexts()).map((t) => t.split("\n").find((l) => /[A-Za-z]/.test(l) && !/^Place/.test(l)) ?? "");

test("ranks: highest first, add, rename, outside the ladder and delete", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto("/admin/ranks");
  await expect(page.getByRole("heading", { level: 1, name: "Ranks" })).toBeVisible();
  await expect(page.getByText("Highest first. A higher rank can fill a lower rank's spot.")).toBeVisible();

  // Highest first: Deputy Sheriff above CSO above Posse; Dispatcher sits outside the ladder.
  const order = (await names(page)).join(" | ");
  expect(order.indexOf("Deputy Sheriff")).toBeLessThan(order.indexOf("CSO"));
  expect(order.indexOf("CSO")).toBeLessThan(order.indexOf("Posse"));
  await expect(outside(page).getByText("Dispatcher")).toBeVisible();

  // A rank people hold cannot be deleted: it says why, and Turn off waits until nobody holds it.
  const deputy = ladder(page).getByRole("listitem").filter({ hasText: "Deputy Sheriff" });
  await expect(deputy.getByRole("button", { name: "Delete Deputy Sheriff" })).toHaveCount(0);
  await expect(deputy.getByRole("button", { name: "Turn off Deputy Sheriff" })).toBeDisabled();

  // Add at the top: the posted positions change, so the page asks first.
  await page.getByRole("textbox", { name: "Rank name" }).fill("Sergeant E2E");
  await page.getByRole("combobox", { name: "Where" }).selectOption("1");
  await page.getByRole("button", { name: "Add rank" }).click();
  const confirm = page.getByRole("region", { name: /Add Sergeant E2E: this changes who can fill these positions/ });
  await expect(confirm).toBeVisible();
  await expect(confirm.getByText(/Deputy Sheriff spots: Sergeant E2E can now fill them/)).toBeVisible();
  await confirm.getByRole("button", { name: "Make the change" }).click();
  await expect(confirm).toBeHidden();
  await expect.poll(async () => (await names(page))[0]).toContain("Sergeant E2E");
  expect(await audits("rank.create", "Sergeant E2E")).toBe(1);

  // Rename in place.
  await ladder(page).getByRole("button", { name: "Rename Sergeant E2E" }).click();
  const rename = page.getByRole("form", { name: "Rename Sergeant E2E" });
  await rename.getByRole("textbox", { name: "Rank name" }).fill("Senior Sergeant E2E");
  await rename.getByRole("button", { name: "Save" }).click();
  await expect(ladder(page).getByText("Senior Sergeant E2E")).toBeVisible();
  expect(await audits("rank.rename", "Senior Sergeant E2E")).toBe(1);

  // Out of the ladder: it stops filling other ranks' spots, after the confirm step.
  await ladder(page).getByRole("button", { name: "Move Senior Sergeant E2E outside the ladder" }).click();
  const out = page.getByRole("region", { name: /Move Senior Sergeant E2E outside the ladder/ });
  await expect(out.getByText(/Senior Sergeant E2E can no longer fill them/).first()).toBeVisible();
  await out.getByRole("button", { name: "Make the change" }).click();
  await expect(outside(page).getByText("Senior Sergeant E2E")).toBeVisible();
  await expect(ladder(page).getByText("Senior Sergeant E2E")).toHaveCount(0);

  // Never used, so it can be deleted (after a second press).
  const row = outside(page).getByRole("listitem").filter({ hasText: "Senior Sergeant E2E" });
  await row.getByRole("button", { name: "Delete Senior Sergeant E2E" }).click();
  await expect(row.getByText("Delete is only for a rank added by mistake.")).toBeVisible();
  await row.getByRole("button", { name: "Delete Senior Sergeant E2E" }).click();
  await expect(page.getByText("Senior Sergeant E2E deleted.")).toBeVisible();
  await expect(outside(page).getByText("Senior Sergeant E2E")).toHaveCount(0);
  expect(await audits("rank.delete", "Senior Sergeant E2E")).toBe(1);
});
