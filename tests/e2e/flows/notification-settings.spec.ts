import { DESKTOP, agencyAt, expect, one, test } from "../fixtures";

/**
 * Agency notification settings: with vendor email turned off for "Detail canceled", a coordinator's cancel sends the
 * vendor no email, but the vendor's inbox still records it, and the deputy on the detail is still emailed.
 */
test("vendor email off for Detail canceled: no vendor email on a staff cancel, the inbox records it", async ({ agency, session, mail, clock }) => {
  const title = `Night market ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(9, 17) });
  await agency.signUp(job, agency.deputy);
  const admin = await session(agency.admin, { viewport: DESKTOP });
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });
  const vendor = await session(agency.vendorLogin, { viewport: DESKTOP });
  const vendorSwitch = admin.getByRole("switch", { name: "Email to vendors: Detail canceled" });

  await admin.goto("/admin/settings/notifications");
  await expect(vendorSwitch).toHaveAttribute("aria-checked", "true");
  await vendorSwitch.click();
  await expect(admin.getByRole("status").filter({ hasText: "Email to vendors for Detail canceled turned off." })).toBeVisible();
  try {
    await admin.reload();
    await expect(vendorSwitch).toHaveAttribute("aria-checked", "false");
    await expect(admin.getByRole("switch", { name: "Email to deputies and personnel: Detail canceled" })).toHaveAttribute("aria-checked", "true");

    await coordinator.goto(`/coordinate/details/${job.id}`);
    await coordinator.getByRole("button", { name: "Cancel detail" }).click();
    await coordinator.getByLabel("Reason", { exact: true }).fill("Lot closed for paving");
    const since = mail.mark();
    await coordinator.getByRole("button", { name: "Cancel detail" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Detail canceled." })).toBeVisible();

    await clock.deliver();
    await mail.waitFor({ to: agency.deputy.email, since });
    expect(mail.find({ to: agency.vendorLogin.email, since })).toHaveLength(0);
    const inbox = await one<{ n: string }>("select count(*) as n from notifications where user_id = $1 and type = 'job.canceled'", [agency.vendorLogin.id]);
    expect(inbox.n).toBe("1");
    await vendor.goto("/alerts");
    await expect(vendor.getByRole("main")).toContainText(`Detail #${job.number} on `);
    await expect(vendor.getByRole("main")).not.toContainText("paving");
  } finally {
    await admin.goto("/admin/settings/notifications");
    if ((await vendorSwitch.getAttribute("aria-checked")) === "false") {
      await vendorSwitch.click();
      await expect(admin.getByRole("status").filter({ hasText: "turned on" })).toBeVisible();
    }
  }
});
