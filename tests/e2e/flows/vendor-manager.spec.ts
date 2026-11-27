import { DESKTOP, PHONE, agencyAt, agencyDay, expect, one, sql, test } from "../fixtures";

/**
 * A school resource sergeant manages the school's details for the agency (owner decision 2026-11-27). An admin
 * chooses the vendor on the sergeant's page; the sergeant keeps the deputy tabs, gets Manage, creates a held detail
 * with a School Resource Deputy position, opens it, assigns a flagged deputy and releases it. Another vendor's detail
 * has no Manage tab, and the staff screens stay closed.
 */
test("a vendor manager creates, staffs and releases a detail for their school, and nothing else", async ({ agency, session }) => {
  const sergeant = await agency.addDeputy("Morgan Hale");
  const srd = await agency.addDeputy("Casey Brandt", { flags: ["School Resource Deputy"] });
  const [other] = await sql<{ id: string }>("insert into vendors (id, name) values (gen_random_uuid()::text, $1) returning id", [`Harbor Fair ${agency.tag}`]);
  const otherDetail = await agency.detail({ title: `Harbor fair gate ${agency.tag}`, startAt: agencyAt(6, 9), vendorId: other.id });
  const title = `Homecoming game ${agency.tag}`;

  await test.step("an admin chooses the vendors the sergeant manages, and it is audited", async () => {
    const admin = await session(agency.admin, { viewport: DESKTOP });
    await admin.goto(`/admin/users/${sergeant.id}`);
    const card = admin.locator("#managed-vendors");
    await card.getByRole("checkbox", { name: agency.vendor.name }).check();
    await card.getByRole("button", { name: "Save vendors" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "They manage 1 vendor." })).toBeVisible();
    const row = await one<{ actor: string }>("select actor_user_id as actor from audit_log where action = 'user.managed_vendors' and entity_id = $1", [sergeant.id]);
    expect(row.actor).toBe(agency.admin.id);
  });

  const page = await session(sergeant, { viewport: PHONE });

  await test.step("the sergeant keeps the deputy tabs and finds Manage on More", async () => {
    await page.goto("/more");
    await expect(page.getByRole("heading", { name: "Vendor manager" })).toBeVisible();
    await page.getByRole("link", { name: "Manage" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Manage" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: agency.vendor.name })).toBeVisible();
    await expect(page.getByRole("main")).not.toContainText(`Harbor Fair ${agency.tag}`);
  });

  await test.step("they create a held detail with a School Resource Deputy position, for their vendor only", async () => {
    await page.getByRole("link", { name: "New detail" }).click();
    const vendor = page.getByLabel("Vendor", { exact: true });
    await expect(vendor.locator("option", { hasText: `Harbor Fair ${agency.tag}` })).toHaveCount(0);
    await vendor.selectOption({ label: agency.vendor.name });
    await page.getByLabel("Title", { exact: true }).fill(title);
    await page.getByLabel("Start time").fill("18:00");
    await page.getByLabel("End time").fill("22:00");
    await page.getByLabel("Position 1", { exact: true }).selectOption({ label: "School Resource Deputy" });
    await page.getByLabel("Hold: do not release until I release it").check();
    await page.getByRole("tab", { name: "Range" }).click();
    const day = agencyDay(agencyAt(5, 12));
    await page.getByLabel("From", { exact: true }).fill(day);
    await page.getByLabel("To", { exact: true }).fill(day);
    await page.getByRole("button", { name: "Create detail" }).click();
    await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
    const job = await one<{ held: boolean; by: string }>("select j.held, a.actor_user_id as by from jobs j join audit_log a on a.entity_id = j.id and a.action = 'job.create' where j.title = $1", [title]);
    expect(job).toEqual({ held: true, by: sergeant.id });
  });

  const job = await one<{ id: string; number: number }>("select id, number from jobs where title = $1", [title]);

  await test.step("they open it on Manage this detail, release it and assign the flagged deputy", async () => {
    await page.goto(`/jobs/${job.number}?tab=manage`);
    await expect(page.getByRole("navigation", { name: "Detail sections" }).getByRole("link", { name: "Manage this detail" })).toHaveAttribute("aria-current", "page");
    const release = page.getByRole("button", { name: /^Release now$|^Release$/ }).last();
    await release.click();
    await expect(page.getByRole("status").filter({ hasText: /^Released\./ })).toBeVisible();
    const after = await one<{ held: boolean }>("select held from jobs where id = $1", [job.id]);
    expect(after.held).toBe(false);
    await page.getByRole("button", { name: "Assign someone" }).click();
    await page.getByLabel("Person", { exact: true }).selectOption({ label: srd.name });
    await page.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(page.getByRole("status").filter({ hasText: "Assigned." })).toBeVisible();
    await expect(page.getByRole("list", { name: "Sign-up history" })).toContainText(srd.name);
    const actors = await sql<{ action: string }>("select action from audit_log where actor_user_id = $1 and (entity_id = $2 or entity_id in (select id from assignments where job_id = $2)) order by at", [sergeant.id, job.id]);
    expect(actors.map((a) => a.action)).toEqual(expect.arrayContaining(["job.create", "assignment.assign", "job.release_hold"]));
    // No coordinator-only controls on their page.
    await expect(page.getByRole("button", { name: /No-show/ })).toHaveCount(0);
  });

  await test.step("another vendor's detail has no Manage tab, and the staff screens stay closed", async () => {
    await page.goto(`/jobs/${otherDetail.number}?tab=manage`);
    await expect(page.getByRole("navigation", { name: "Detail sections" })).toHaveCount(0);
    for (const path of ["/coordinate", "/coordinate/payments", "/coordinate/vendors", "/coordinate/reports", "/admin", "/admin/audit"]) {
      await page.goto(path);
      await expect(page, path).toHaveURL(/\/home$/);
    }
  });
});
