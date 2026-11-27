import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { agencyDateParts } from "@/domain/time/agency-time";
import { COORD } from "./coordinator-fixtures";
import { E2E } from "./env";
import { signInAs } from "./session";
import { VENDOR } from "./vendor-fixtures";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

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
const vendorId = async (name: string) => (await rows<{ id: string }>("select id from vendors where name = $1", [name]))[0].id;

/** The coming December: details made here never land in the past. */
function december(): number {
  const p = agencyDateParts(new Date());
  return p.month === 12 ? p.year + 1 : p.year;
}

test("a coordinator keeps a vendor's site contacts, and the detail form fills the phone from the one chosen", async ({ page, context }) => {
  const title = "Gym doors, contact picked";
  const vid = await vendorId(COORD.vendor);
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto(`/coordinate/vendors/${vid}`);

  const section = page.getByRole("region", { name: /^Site contacts/ });
  await section.getByRole("button", { name: "Add a contact" }).click();
  const add = section.getByRole("form", { name: "New contact" });
  await add.getByLabel("Name").fill("Gym office");
  await add.getByLabel("Phone").fill("8505550160");
  await add.getByLabel("Notes").fill("Ask for the athletic director.");
  await add.getByRole("button", { name: "Add contact" }).click();
  await expect(section.getByRole("link", { name: "850-555-0160" })).toBeVisible();
  await expect(section.getByText("Ask for the athletic director.")).toBeVisible();

  await section.getByRole("button", { name: "Add a contact" }).click();
  await add.getByLabel("Name").fill("Old front desk");
  await add.getByLabel("Phone").fill("8505550169");
  await add.getByRole("button", { name: "Add contact" }).click();
  await section.getByRole("button", { name: "Deactivate Old front desk" }).click();
  await expect(section.getByRole("button", { name: "Reactivate Old front desk" })).toBeVisible();
  await expect(section.getByText("Inactive")).toBeVisible();
  await page.setViewportSize(PHONE);
  await expectNoSeriousA11yIssues(page);
  await page.setViewportSize(DESKTOP);

  // The new detail form offers the active contacts only, and fills the phone for this detail.
  await page.goto("/jobs/new");
  const picker = page.getByLabel("Site contact", { exact: true });
  await expect(picker).toBeDisabled();
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: COORD.vendor });
  await expect(picker.locator("option")).toHaveText(["No site contact", "Gym office", "Add a new contact"]);
  await picker.selectOption({ label: "Gym office" });
  await expect(page.getByLabel("Contact phone")).toHaveValue("850-555-0160");
  await page.getByLabel("Contact phone").fill("8505550161");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Start time").fill("18:00");
  await page.getByLabel("End time").fill("22:00");
  await page.getByRole("tab", { name: "Range" }).click();
  await page.getByLabel("From", { exact: true }).fill(`${december()}-12-09`);
  await page.getByLabel("To", { exact: true }).fill(`${december()}-12-09`);
  await page.getByRole("button", { name: "Create detail" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const [job] = await rows<{ id: string; contact_name: string; contact_phone: string }>("select id, contact_name, contact_phone from jobs where title = $1", [title]);
  expect(job).toMatchObject({ contact_name: "Gym office", contact_phone: "850-555-0161" });
  expect(await rows("select phone from vendor_contacts where name = 'Gym office'")).toEqual([{ phone: "850-555-0160" }]);

  // The edit form shows the chosen contact, and a new contact added there is saved to the vendor.
  await page.getByRole("button", { name: "Edit detail" }).click();
  const edit = page.getByRole("form", { name: "Edit detail" });
  await expect(edit.getByLabel("Site contact", { exact: true })).toHaveValue(/.+/);
  await expect(edit.getByLabel("Site contact", { exact: true }).locator("option:checked")).toHaveText("Gym office");
  await expect(edit.getByLabel("Contact phone")).toHaveValue("850-555-0161");
  await edit.getByLabel("Site contact", { exact: true }).selectOption({ label: "Add a new contact" });
  await edit.getByLabel("Contact name").fill("Concession stand");
  await edit.getByLabel("Contact phone").fill("8505550162");
  await edit.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect(await rows("select contact_name, contact_phone from jobs where id = $1", [job.id])).toEqual([{ contact_name: "Concession stand", contact_phone: "850-555-0162" }]);
  expect(await rows("select phone, active from vendor_contacts where name = 'Concession stand' and vendor_id = $1", [vid])).toEqual([{ phone: "850-555-0162", active: true }]);
});

test("a vendor manages its own site contacts on Locations and never sees another vendor's", async ({ page, context }) => {
  const other = await vendorId(COORD.vendor);
  await rows("insert into vendor_contacts (id, vendor_id, name, phone) values (gen_random_uuid()::text, $1, 'School resource desk', '850-555-0170')", [other]);
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await page.goto("/vendor/locations");
  const section = page.getByRole("region", { name: "Site contacts" });
  await expect(section.getByText("School resource desk")).toHaveCount(0);
  await section.getByRole("button", { name: "Add a contact" }).click();
  const add = section.getByRole("form", { name: "New contact" });
  await add.getByLabel("Name").fill("Box office");
  await add.getByLabel("Phone").fill("8505550171");
  await add.getByLabel("Email").fill("boxoffice@lakeview.example");
  await add.getByRole("button", { name: "Add contact" }).click();
  await expect(section.getByRole("link", { name: "850-555-0171" })).toBeVisible();
  await expect(section.getByRole("link", { name: "boxoffice@lakeview.example" })).toBeVisible();

  await section.getByRole("button", { name: "Edit Box office" }).click();
  const edit = section.getByRole("form", { name: "Edit Box office" });
  await edit.getByLabel("Phone").fill("8505550172");
  await edit.getByRole("button", { name: "Save contact" }).click();
  await expect(section.getByRole("link", { name: "850-555-0172" })).toBeVisible();
  await expectNoSeriousA11yIssues(page);

  await page.goto("/vendor/request");
  const picker = page.getByLabel("Site contact", { exact: true });
  await expect(picker.locator("option")).toContainText(["No site contact", "Box office", "Add a new contact"]);
  await expect(picker.locator("option", { hasText: "School resource desk" })).toHaveCount(0);
  await picker.selectOption({ label: "Box office" });
  await expect(page.getByLabel("Contact phone")).toHaveValue("850-555-0172");

  await page.goto("/vendor/locations");
  await section.getByRole("button", { name: "Deactivate Box office" }).click();
  await expect(section.getByRole("button", { name: "Reactivate Box office" })).toBeVisible();
  const vid = await vendorId(VENDOR.name);
  expect(await rows("select active from vendor_contacts where name = 'Box office' and vendor_id = $1", [vid])).toEqual([{ active: false }]);
  const audit = await rows<{ action: string }>("select a.action from audit_log a join vendor_contacts c on c.id = a.entity_id where c.name = 'Box office' order by a.at");
  expect(audit.map((a) => a.action)).toEqual(["vendor_contact.create", "vendor_contact.update", "vendor_contact.deactivate"]);
});
