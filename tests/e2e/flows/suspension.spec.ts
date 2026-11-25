import { DESKTOP, PHONE, agencyAt, agencyDay, expect, test } from "../fixtures";

/**
 * A suspension takes a deputy off a detail: staff read "Removed by suspension", the deputy reads a plain "Canceled",
 * and the vendor sees no reason at all.
 */
test("suspension: staff see Removed by suspension, the deputy sees Canceled, the vendor sees no reason", async ({ agency, session }) => {
  const title = `Pier fishing derby ${agency.tag}`;
  const reason = "Missed two details without notice";
  const job = await agency.detail({ title, startAt: agencyAt(4, 6) });
  const jordan = await agency.addDeputy(`Jordan Pike ${agency.tag}`);
  await agency.signUp(job, jordan);

  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });
  const deputy = await session(jordan, { viewport: PHONE });
  const vendor = await session(agency.vendorLogin, { viewport: PHONE });

  await test.step("the vendor sees who is coming", async () => {
    await vendor.goto(`/vendor/details/${job.id}`);
    await expect(vendor.getByRole("main")).toContainText(jordan.name);
  });

  await test.step("a coordinator suspends the deputy", async () => {
    await coordinator.goto(`/admin/users/${jordan.id}`);
    await coordinator.getByRole("button", { name: "Suspend user" }).click();
    await coordinator.getByLabel("Reason").fill(reason);
    await coordinator.getByLabel("Suspended until").fill(agencyDay(agencyAt(30, 12)));
    await coordinator.getByLabel("Remove them from details they signed up for").check();
    await coordinator.getByRole("button", { name: "Confirm suspension" }).click();
    await expect(coordinator.getByRole("status")).toContainText("Suspended.");
  });

  await test.step("staff see Removed by suspension on the detail", async () => {
    await coordinator.goto(`/coordinate/details/${job.id}`);
    const history = coordinator.getByRole("list", { name: "Sign-up history" });
    await expect(history.getByRole("listitem").filter({ hasText: jordan.name })).toContainText("Removed by suspension");
  });

  await test.step("the deputy sees a plain Canceled, with no word of the suspension", async () => {
    await deputy.goto("/home");
    const row = deputy.getByRole("region", { name: "Up next" }).getByRole("listitem").filter({ hasText: title });
    await expect(row.getByText("Canceled", { exact: true })).toBeVisible();
    await expect(row.getByText("Your sign-up was canceled.")).toBeVisible();
    await expect(deputy.locator("body")).not.toContainText(/suspen/i);
    await expect(deputy.locator("body")).not.toContainText(reason);
  });

  await test.step("the vendor sees the spot open again and no reason", async () => {
    await vendor.reload();
    await expect(vendor.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(vendor.getByRole("main")).not.toContainText(jordan.name);
    await expect(vendor.locator("body")).not.toContainText(/suspen/i);
    await expect(vendor.locator("body")).not.toContainText(reason);
  });
});
