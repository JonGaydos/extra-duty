import type { Page } from "@playwright/test";
import { DESKTOP, PHONE, agencyAt, expect, one, pdf, sql, type Person, test } from "../fixtures";

/**
 * Coordinators and admins also work details, so everything a deputy has works for them too: the same tabs as a deputy
 * (Home, Details, Billing, Profile; Profile from More on a phone), starting on Home, signing up, hiding a vendor, every
 * Profile setting, the personal calendar link, billing their own detail and confirming its payment.
 */
for (const [role, viewport] of [
  ["coordinator", DESKTOP],
  ["admin", PHONE],
] as const) {
  test(`a ${role} works a detail of their own, end to end, on a ${viewport === PHONE ? "phone" : "desktop"}`, async ({ agency, session, clock }) => {
    const me: Person = role === "coordinator" ? agency.coordinator : agency.admin;
    const workedTitle = `Harbor fireworks ${agency.tag} ${role}`;
    const openTitle = `Library book sale ${agency.tag} ${role}`;
    const worked = await agency.detail({ title: workedTitle, startAt: agencyAt(1, 8) });
    const open = await agency.detail({ title: openTitle, startAt: agencyAt(9, 8) });
    // Staff who work details hold a rank like any deputy.
    await sql("update users set rank_id = (select id from ranks where name = 'Deputy Sheriff') where id = $1", [me.id]);
    await agency.signUp(worked, me);
    await clock.advanceTo(worked.id, "end", 60);
    const page = await session(me, { viewport });

    await test.step("they start on Home, with their To-do on top, and use the deputy's own tabs", async () => {
      await page.goto("/");
      await expect(page).toHaveURL(/\/home$/);
      await expect(page.getByTestId("home-todo").getByRole("link", { name: "Open To-do" })).toBeVisible();
      await page.goto("/coordinate");
      await openOwn(page, viewport, "Home");
      await expect(page).toHaveURL(/\/home$/);
      await openOwn(page, viewport, "Details");
      await expect(page).toHaveURL(/\/jobs$/);
      await expect(page.getByRole("heading", { level: 1, name: "Details" })).toBeVisible();
    });

    await test.step("hide a vendor, show it again from Profile, then sign up for its open detail", async () => {
      await page.goto(`/jobs/${open.id}`);
      await page.getByRole("button", { name: "Hide this vendor from my lists" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Vendor hidden from your lists." })).toBeVisible();
      await page.goto("/profile");
      await page.getByRole("button", { name: /Show again/ }).first().click();
      // The row leaves the list once the vendor is shown again.
      await expect.poll(async () => (await sql("select 1 from hidden_vendors where user_id = $1", [me.id])).length).toBe(0);
      await expect(page.getByRole("button", { name: /Show again/ })).toHaveCount(0);
      await page.goto(`/jobs/${open.id}`);
      await page.getByRole("button", { name: "Sign up for Deputy Sheriff" }).click();
      await page.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and sign up" }).click();
      await expect(page.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();
    });

    await test.step("Profile: mailing address, W-9, schedule, earnings goal, theme and maps app", async () => {
      await openOwn(page, viewport, "Profile");
      await expect(page).toHaveURL(/\/profile$/);
      await page.getByLabel("Mailing address").fill("PO Box 77, Gulf Haven, FL 32400");
      await page.getByLabel("Phone", { exact: true }).click();
      await expect(page.getByText(/Not verified|Found on the map|Did you mean/).first()).toBeVisible();
      await page.getByRole("button", { name: "Save contact details" }).click();
      await expect.poll(async () => (await one<{ a: string | null }>("select mailing_address as a from users where id = $1", [me.id])).a).toBe("PO Box 77, Gulf Haven, FL 32400");
      await page.getByLabel("Replace your W-9").setInputFiles(pdf(`W-9 ${me.name}`));
      await page.getByRole("button", { name: "Upload W-9" }).click();
      await expect(page.getByRole("status").filter({ hasText: "W-9 uploaded. It waits for review." })).toBeVisible();
      await page.getByRole("button", { name: "Save schedule" }).click();
      await expect(page.getByRole("status").filter({ hasText: /Schedule (saved|turned off)\./ })).toBeVisible();
      await page.getByLabel("Monthly earnings goal").fill("1500");
      await page.getByRole("button", { name: "Save goal" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Goal saved." })).toBeVisible();
      await page.getByRole("main").getByRole("radiogroup", { name: "Theme" }).getByRole("radio", { name: "Night" }).check();
      await expect.poll(async () => (await one<{ t: string | null }>("select theme_preference as t from users where id = $1", [me.id])).t).toBe("night");
      await page.getByRole("main").locator("#maps").getByRole("radio", { name: "Apple Maps" }).check();
      await expect.poll(async () => (await one<{ a: string | null }>("select preferred_maps_app as a from users where id = $1", [me.id])).a).toBe("apple");
    });

    await test.step("the personal calendar link", async () => {
      await page.goto("/calendar");
      await page.getByRole("button", { name: /^Make (calendar link|a new link)$/ }).click();
      await expect(page.getByLabel("Your calendar link")).toHaveValue(/\/api\/v1\/calendar\.ics\?token=/);
    });

    await test.step("bill the worked detail through Billing and confirm the payment", async () => {
      await page.goto("/coordinate");
      await openOwn(page, viewport, "Billing");
      await expect(page).toHaveURL(/\/billing$/);
      await page.getByRole("article", { name: `${agency.vendor.name}, ${workedTitle}` }).getByRole("link", { name: "Review and send invoice" }).click();
      await page.getByRole("button", { name: "Send invoice" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Invoice sent to the vendor." })).toBeVisible();
      await markReceived(page, workedTitle);
      // The confirmation alone closes it (owner decision 2026-11-26); Payments lists it, quietly, as Vendor not confirmed.
      const inv = await one<{ id: string; status: string }>("select i.id, i.status from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1 and a.user_id = $2", [worked.id, me.id]);
      expect(inv.status).toBe("paid");
      await page.goto(`/coordinate/payments?status=not_confirmed&open=${inv.id}`);
      await expect(page.getByRole("table").filter({ hasText: me.name })).toBeVisible();
      await expect(page.getByText("Paid (confirmed by deputy)")).toBeVisible();
    });
  });
}

/** Opens one of the shared tabs: the top nav on a desktop; the tab bar, or More for Profile, on a phone. */
async function openOwn(page: Page, viewport: { width: number }, name: string): Promise<void> {
  if (viewport.width >= 768) {
    await page.locator('[data-shell="top-nav"]').getByRole("navigation", { name: "Main" }).getByRole("link", { name, exact: true }).click();
  } else if (name !== "Profile") {
    await page.locator('[data-shell="tab-bar"]').getByRole("link", { name, exact: true }).click();
  } else {
    await page.locator('[data-shell="tab-bar"]').getByRole("link", { name: "More" }).click();
    await page.getByRole("main").getByRole("link", { name, exact: true }).click();
  }
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
}

/** The deputy's own "Mark received", on the Waiting tab of Billing (the invoice page itself is the staff view). */
async function markReceived(page: Page, title: string): Promise<void> {
  await page.goto("/billing?tab=waiting");
  await page.getByRole("article").filter({ hasText: title }).getByRole("button", { name: /^Mark received/ }).click();
  await page.getByRole("button", { name: "Record payment" }).click();
  // The card can leave the Waiting tab, its message with it, as soon as the payment closes the invoice.
  await expect(page.getByRole("status").filter({ hasText: "Payment recorded." }).or(page.getByRole("article").filter({ hasText: title }).getByText(/Paid/))
    .or(page.getByRole("heading", { name: "Nothing waiting" }))).toBeVisible();
}
