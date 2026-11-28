import { PHONE, agencyAt, expect, sql, test } from "../fixtures";

/**
 * Owner request 2026-11-27: Home's billing banner. It shows while a worked detail is not billed, says plainly when the
 * lock is on, opens Billing at what needs action, goes away once billed, and comes back for a payment the vendor
 * reported that waits for the deputy's confirmation.
 */
test("the billing banner: unbilled work, the lock wording, cleared by billing, and a vendor-reported payment", async ({ agency, session, clock }) => {
  const title = `Harbor lot ${agency.tag}`;
  const worked = await agency.detail({ title, startAt: agencyAt(1, 8) });
  const riley = await agency.addDeputy(`Riley Quinn ${agency.tag}`);
  await agency.signUp(worked, riley);
  await sql("update users set mailing_address = '1 Main St, Gulf Haven, FL 32400' where id = $1", [riley.id]);
  const deputy = await session(riley, { viewport: PHONE });
  const banner = deputy.getByTestId("billing-banner");

  await test.step("just after the detail ends: the banner asks to bill it", async () => {
    await clock.advanceTo(worked.id, "end", 30);
    await deputy.goto("/home");
    await expect(banner).toContainText("You have 1 worked detail to bill.");
    await expect(banner).toContainText("Billing them keeps your sign-ups open.");
    await expect(banner.getByRole("button", { name: /close|dismiss/i })).toHaveCount(0);
  });

  await test.step("past the grace period the lock is on, and the banner says so", async () => {
    await clock.advanceTo(worked.id, "end", 25 * 60);
    await deputy.reload();
    await expect(banner).toContainText("Sign-ups are locked until you bill these.");
  });

  await test.step("Go to billing opens To bill; billing the detail clears the banner", async () => {
    await banner.getByRole("link", { name: "Go to billing" }).click();
    await expect(deputy).toHaveURL(/\/billing\?tab=bill$/);
    await deputy.getByRole("article", { name: `${agency.vendor.name}, ${title}` }).getByRole("link", { name: "Review and send invoice" }).click();
    await deputy.getByRole("button", { name: "Send invoice" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "Invoice sent to the vendor." })).toBeVisible();
    await deputy.goto("/home");
    await expect(banner).toHaveCount(0);
  });

  await test.step("a payment the vendor reported needs the deputy's attention", async () => {
    await sql("update invoices set vendor_paid_at = now(), responsible_party = 'deputy', responsible_since = now() where payee_user_id = $1", [riley.id]);
    await deputy.reload();
    await expect(banner).toContainText("1 invoice needs your attention.");
    await banner.getByRole("link", { name: "Go to billing" }).click();
    await expect(deputy).toHaveURL(/\/billing\?tab=waiting&needs=1$/);
    await expect(deputy.getByTestId("needs-filter")).toContainText("Showing the invoice that needs your attention.");
  });
});
