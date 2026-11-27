import { DESKTOP, PHONE, agencyAt, expect, test } from "../fixtures";

/**
 * Flow (c): a detail the deputy worked goes unbilled past the grace period, so the deputy cannot sign up for anything
 * else; the reminder goes out, the coordinator sees the lock, and billing the detail lifts it.
 */
test("an unbilled detail blocks sign-up until it is billed", async ({ agency, session, mail, clock }) => {
  const workedTitle = `Boat ramp lot ${agency.tag}`;
  const nextTitle = `Farmers market gate ${agency.tag}`;
  const worked = await agency.detail({ title: workedTitle, startAt: agencyAt(1, 8) });
  const next = await agency.detail({ title: nextTitle, startAt: agencyAt(6, 8) });
  // A name of this run's own, so the coordinator's lock list is read without other runs' rows.
  const casey = await agency.addDeputy(`Casey Lin ${agency.tag}`);
  await agency.signUp(worked, casey);

  const deputy = await session(casey, { viewport: PHONE });
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });

  await test.step("the worked detail ended more than 24 hours ago and is still unbilled", async () => {
    await clock.advanceTo(worked.id, "end", 25 * 60);
    const since = mail.mark();
    await clock.tick("unbilled-reminders");
    await clock.deliver();
    const reminder = await mail.waitFor({ to: casey.email, subject: "1 item needs your attention", since });
    expect(reminder.text).toContain(`Bill Detail #${worked.number}, ${workedTitle}`);
  });

  await test.step("the deputy cannot sign up for another detail", async () => {
    await deputy.goto(`/jobs/${next.id}`);
    await expect(deputy.getByText("Bill 1 past detail to sign up again")).toBeVisible();
    await expect(deputy.getByRole("button", { name: "Sign up for Deputy Sheriff" })).toBeDisabled();
  });

  await test.step("the coordinator sees the sign-up lock", async () => {
    await coordinator.goto("/coordinate");
    const locks = coordinator.getByRole("region", { name: /^Sign-up locks/ });
    await expect(locks.getByRole("listitem").filter({ hasText: casey.name })).toContainText("1 unbilled detail");
  });

  await test.step("the deputy bills it, and sign-up opens again", async () => {
    await deputy.goto("/billing");
    await deputy.getByRole("article", { name: `${agency.vendor.name}, ${workedTitle}` }).getByRole("link", { name: "Review and send invoice" }).click();
    await deputy.getByRole("button", { name: "Send invoice" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "Invoice sent to the vendor." })).toBeVisible();

    await deputy.goto(`/jobs/${next.id}`);
    await expect(deputy.getByText("Bill 1 past detail to sign up again")).toHaveCount(0);
    await deputy.getByRole("button", { name: "Sign up for Deputy Sheriff" }).click();
    await deputy.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and sign up" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();

    await coordinator.reload();
    await expect(coordinator.getByRole("main").getByRole("listitem").filter({ hasText: casey.name })).toHaveCount(0);
  });
});
