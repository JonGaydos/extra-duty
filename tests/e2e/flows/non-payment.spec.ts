import { DESKTOP, PHONE, agencyAt, agencyDay, expect, one, test } from "../fixtures";

/**
 * Flow (e): the vendor's 30 days to pay run out on the clock, the deputy reports non-payment, the coordinator adds a
 * note and puts it on the vendor, the vendor pays, the deputy confirms, and the invoice and the issue close as paid.
 */
test("non-payment report, coordinator note, then paid", async ({ agency, session, mail, clock }) => {
  const title = `Golf cart parade ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(-2, 9) });
  await agency.signUp(job, agency.deputy);
  const note = "Called the vendor's office; they are cutting a check this week.";

  const deputy = await session(agency.deputy, { viewport: PHONE });
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });
  const vendor = await session(agency.vendorLogin, { viewport: PHONE });

  await test.step("the deputy bills the detail and it goes to the vendor", async () => {
    await deputy.goto("/billing");
    await deputy.getByRole("article", { name: `${agency.vendor.name}, ${title}` }).getByRole("link", { name: "Review and send invoice" }).click();
    await deputy.getByRole("button", { name: "Send invoice" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "Invoice sent to the vendor." })).toBeVisible();
    await clock.deliver();
  });
  const inv = await one<{ id: string; sent_at: Date }>("select i.id, i.sent_at from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1", [job.id]);
  expect(inv.sent_at).not.toBeNull();

  await test.step("30 days pass with no payment; the deputy reports it", async () => {
    await deputy.goto("/billing?tab=waiting");
    await expect(deputy.getByRole("article").filter({ hasText: title }).getByRole("button", { name: /^Report non-payment/ })).toHaveCount(0);
    await clock.advance(job.id, new Date(inv.sent_at.getTime() + 30 * 86_400_000 + 3_600_000));
    await deputy.reload();
    const card = deputy.getByRole("article").filter({ hasText: title });
    await card.getByRole("button", { name: /^Report non-payment/ }).click();
    await card.getByLabel("What happened").fill("Nothing received after 30 days.");
    await card.getByRole("button", { name: "Report non-payment" }).click();
    await expect(card.getByRole("status")).toContainText("Reported. The extra duty office takes it from here.");
  });

  await test.step("the coordinator adds a note for the deputy and puts it on the vendor", async () => {
    await coordinator.goto("/alerts");
    await expect(coordinator.getByRole("main")).toContainText(`${agency.deputy.name} reports not being paid`);
    await coordinator.goto(`/invoices/${inv.id}`);
    await coordinator.getByRole("button", { name: "Add a note" }).click();
    await coordinator.getByLabel("Note", { exact: true }).fill(note);
    await coordinator.getByRole("button", { name: "Add note" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Note added." })).toBeVisible();

    await coordinator.getByRole("button", { name: "Change whose turn" }).click();
    await coordinator.getByLabel("Waiting on").selectOption("vendor");
    await coordinator.getByLabel("Note").fill("Please send payment for this invoice.");
    const since = mail.mark();
    await coordinator.getByRole("button", { name: "Save", exact: true }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Now waiting on the vendor." })).toBeVisible();
    await clock.deliver();
    await mail.waitFor({ to: agency.vendor.billingEmail, since });

    await deputy.goto(`/invoices/${inv.id}`);
    await expect(deputy.getByRole("main")).toContainText(note);
  });

  await test.step("the vendor pays, the deputy confirms, and the issue closes as paid", async () => {
    await vendor.goto("/vendor/invoices");
    const card = vendor.getByRole("article").filter({ hasText: title });
    await card.getByRole("button", { name: /^Mark paid/ }).click();
    await card.getByLabel("Date paid").fill(agencyDay(new Date()));
    await card.getByLabel("Method").selectOption({ label: "Bill.com" });
    await card.getByRole("button", { name: "Record payment" }).click();
    await expect(card.getByRole("status")).toContainText("Marked paid.");

    await deputy.goto("/billing?tab=waiting");
    const waiting = deputy.getByRole("article").filter({ hasText: title });
    await waiting.getByRole("button", { name: /^Mark received/ }).click();
    await waiting.getByLabel("Method").selectOption({ label: "Bill.com" });
    await waiting.getByRole("button", { name: "Record payment" }).click();
    await expect(deputy.getByRole("heading", { name: "Nothing waiting" })).toBeVisible();

    const closed = await one<{ status: string; issue: string }>(
      "select i.status, p.status as issue from invoices i join payment_issues p on p.invoice_id = i.id where i.id = $1",
      [inv.id],
    );
    expect(closed).toEqual({ status: "paid", issue: "paid" });
    await coordinator.goto(`/invoices/${inv.id}`);
    await expect(coordinator.getByRole("main")).toContainText("Payment issue closed");
  });
});
