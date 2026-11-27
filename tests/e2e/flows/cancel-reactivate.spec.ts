import { E2E } from "../env";
import { DESKTOP, PHONE, expect, one, sql, test } from "../fixtures";

/**
 * Canceled inside the late window, then reactivated: late-cancel pay cannot be billed before the detail's end, the
 * reactivation needs a reason, the history keeps both, the former deputies are told and can sign up again.
 */
test("cancel with a late window, reactivate with a reason; history, notices, sign-up again, no early late-cancel billing", async ({ agency, session, mail, clock }) => {
  const title = `Homecoming lot ${agency.tag}`;
  const cancelWhy = "Vendor postponed homecoming";
  const backWhy = "Vendor confirmed it is going ahead";
  // Starts in 22 hours: inside the 24-hour late cancellation window.
  const startAt = new Date(Math.ceil((Date.now() + 22 * 3_600_000) / 900_000) * 900_000);
  const job = await agency.detail({ title, startAt, count: 2 });
  const sam = await agency.addDeputy(`Sam Okafor ${agency.tag}`);
  const drewAssignment = await agency.signUp(job, agency.deputy);
  await agency.signUp(job, sam);

  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });
  const drew = await session(agency.deputy, { viewport: PHONE });
  const vendor = await session(agency.vendorLogin, { viewport: PHONE });

  await test.step("the coordinator cancels for the vendor, inside the late window", async () => {
    await coordinator.goto(`/jobs/${job.id}?tab=manage`);
    await coordinator.getByRole("button", { name: "Cancel detail" }).click();
    await coordinator.getByLabel("Reason", { exact: true }).fill(cancelWhy);
    await coordinator.getByLabel(/^The vendor canceled/).check();
    await coordinator.getByRole("button", { name: "Cancel detail" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Detail canceled." })).toBeVisible();
  });

  await test.step("the deputies are owed late-cancel pay, but it cannot be billed before the detail's end", async () => {
    await drew.goto("/billing?tab=bill");
    const card = drew.getByRole("article", { name: new RegExp(title) });
    await expect(card).toContainText(/You can bill late-cancel pay after [A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M\./);
    await expect(card.getByRole("button", { name: "Review and send invoice" })).toBeDisabled();
    const res = await drew.request.post(`/api/v1/assignments/${drewAssignment}/bill`, {
      headers: { origin: E2E.baseURL },
      data: { startAt: job.startAt.toISOString(), endAt: job.endAt.toISOString() },
    });
    expect(res.status()).toBe(409);
    expect((await res.json()).error.message).toMatch(/^You can bill late-cancel pay after /);
  });

  await test.step("the coordinator reactivates it with a reason; the history shows the cancel and the reactivation", async () => {
    await coordinator.getByRole("button", { name: "Reactivate detail" }).click();
    const confirm = coordinator.getByRole("region", { name: "Reactivate this detail" });
    await expect(confirm.getByTestId("reactivate-notify")).toContainText(agency.deputy.name);
    await expect(confirm.getByTestId("reactivate-notify")).toContainText(sam.name);
    // No reason, no reactivation.
    await confirm.getByRole("button", { name: "Reactivate", exact: true }).click();
    expect(await confirm.getByLabel("Reason", { exact: true }).evaluate((el) => (el as HTMLInputElement).validity.valueMissing)).toBe(true);
    expect((await one<{ state: string }>("select state from jobs where id = $1", [job.id])).state).toBe("canceled");
    await confirm.getByLabel("Reason", { exact: true }).fill(backWhy);
    const since = mail.mark();
    await confirm.getByRole("button", { name: "Reactivate", exact: true }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Detail reactivated." })).toBeVisible();
    const events = coordinator.getByRole("list", { name: "Sign-up history" }).getByTestId("detail-event");
    await expect(events).toHaveCount(2);
    await expect(events.nth(0)).toContainText(`Canceled by ${agency.coordinator.name} on`);
    await expect(events.nth(0)).toContainText(cancelWhy);
    await expect(events.nth(1)).toContainText(`Reactivated by ${agency.coordinator.name} on`);
    await expect(events.nth(1)).toContainText(backWhy);

    await clock.deliver();
    for (const p of [agency.deputy, sam]) await mail.waitFor({ to: p.email, subject: new RegExp(title), since });
  });

  await test.step("a former deputy is told it is back on and signs up again; the vendor sees it scheduled", async () => {
    await drew.goto("/alerts");
    await expect(drew.getByRole("main")).toContainText("is back on. Sign up again if you still want it.");
    await drew.goto(`/jobs/${job.id}`);
    for (const why of [cancelWhy, backWhy]) await expect(drew.locator("body")).not.toContainText(why);
    await drew.getByRole("button", { name: "Sign up for Deputy Sheriff" }).click();
    await drew.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and sign up" }).click();
    await expect(drew.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();

    await vendor.goto(`/vendor/details/${job.id}`);
    await expect(vendor.getByRole("main")).toContainText("Scheduled");
    for (const why of [cancelWhy, backWhy]) await expect(vendor.locator("body")).not.toContainText(why);
  });

  const rows = await sql<{ email: string; status: string }>("select u.email, a.status from assignments a join users u on u.id = a.user_id where a.job_id = $1 order by a.created_at", [job.id]);
  expect(rows).toEqual([
    { email: agency.deputy.email, status: "canceled" },
    { email: sam.email, status: "canceled" },
    { email: agency.deputy.email, status: "signed_up" },
  ]);
});
