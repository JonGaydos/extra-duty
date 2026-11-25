import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";
import { laterLocalInput } from "../clock";
import { PHONE, agencyDay, dateTimeText, expect, one, pdf, test } from "../fixtures";

/**
 * Flow (a), the whole life of one detail with four people signed in at once, each in their own browser and session,
 * each through the real sign-in page with the code from the emailed sign-in message: the vendor requests a detail,
 * the coordinator approves it, it releases on the 15th at 4:00 PM of the month before, the deputy signs up and bills,
 * the coordinator reviews the invoice, it is emailed with the W-9, the vendor marks it paid, the deputy confirms and
 * the detail is Closed.
 */
test("walkthrough: request, approval, release on the 15th at 4:00 PM, sign-up, billing, review, invoice email with W-9, paid, Closed", async ({ agency, signIn, mail, clock }) => {
  test.setTimeout(240_000);
  const title = `Lakeside concert ${agency.tag}`;
  const now = agencyDateParts(new Date());
  // Two months out: its release (the 15th of next month, 4:00 PM) is still ahead.
  const startAt = agencyInstant(now.year, now.month + 2, 10, 18, 0);
  const releaseAt = agencyInstant(now.year, now.month + 1, 15, 16, 0);

  // Everyone signs in with the code from their email.
  const admin = await signIn(agency.admin);
  const coordinator = await signIn(agency.coordinator);
  const vendor = await signIn(agency.vendorLogin, { viewport: PHONE });
  const deputy = await signIn(agency.deputy, { viewport: PHONE });
  await expect(admin.getByRole("heading", { level: 1 })).toBeVisible();
  await expect(vendor).toHaveURL(/\/vendor$/);
  await expect(deputy).toHaveURL(/\/home$/);

  await test.step("the admin sends a test email through the agency's email server", async () => {
    await admin.goto("/admin/system/email");
    const since = mail.mark();
    await admin.getByRole("button", { name: "Send test email" }).click();
    await expect(admin.getByRole("status")).toContainText(`Test email sent to ${agency.admin.email}.`);
    await mail.waitFor({ to: agency.admin.email, subject: "Extra Duty test email", since });
  });

  await test.step("the deputy uploads a W-9 in Profile", async () => {
    await deputy.goto("/profile");
    await deputy.getByLabel("Upload your W-9").setInputFiles(pdf("W-9 Drew Fowler"));
    await deputy.getByRole("button", { name: "Upload W-9" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "W-9 uploaded." })).toBeVisible();
  });

  await test.step("the vendor requests the detail", async () => {
    await vendor.goto("/vendor/request");
    await vendor.getByLabel("Location", { exact: true }).selectOption({ label: `${agency.vendor.location.name}, ${agency.vendor.location.address}` });
    await vendor.getByLabel("Date", { exact: true }).fill(agencyDay(startAt));
    await vendor.getByLabel("Start", { exact: true }).fill("18:00");
    await vendor.getByLabel("End", { exact: true }).fill("22:00");
    await vendor.getByLabel("Title", { exact: true }).fill(title);
    await vendor.getByLabel("Position", { exact: true }).selectOption({ label: "Deputy Sheriff" });
    await vendor.getByLabel("How many", { exact: true }).fill("1");
    await vendor.getByLabel("What the deputies will do").fill("Parking and crowd control for the lawn concert.");
    await vendor.getByRole("button", { name: "Send request" }).click();
    await expect(vendor.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(vendor.getByText("Waiting for coordinator approval")).toBeVisible();
  });
  const job = await one<{ id: string; number: number }>("select id, number from jobs where title = $1", [title]);

  await test.step("the coordinator approves it from the to-do list; it opens on the 15th at 4:00 PM of the month before", async () => {
    await coordinator.goto("/coordinate");
    await coordinator.getByRole("region", { name: "Vendor requests" }).getByRole("link", { name: `Review request, ${title}` }).click();
    await coordinator.getByRole("button", { name: "Approve request" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Request approved." })).toBeVisible();
    await expect(coordinator.getByRole("main")).toContainText(`Opens ${dateTimeText(releaseAt)}`);
    const saved = await one<{ release_at: Date }>("select release_at from jobs where id = $1", [job.id]);
    expect(saved.release_at.toISOString()).toBe(releaseAt.toISOString());
  });

  await test.step("the vendor sees it scheduled", async () => {
    await vendor.goto("/vendor");
    await expect(vendor.getByRole("listitem").filter({ hasText: title })).toContainText("Scheduled");
  });

  await test.step("before the release the deputy can only watch it", async () => {
    await deputy.goto(`/jobs/${job.id}`);
    await expect(deputy.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(deputy.getByText("Not open for sign-up")).toBeVisible();
    await expect(deputy.getByRole("button", { name: "Sign up for Deputy Sheriff" })).toBeDisabled();
    await deputy.getByRole("switch", { name: "Alert me if it opens" }).click();
    await expect(deputy.getByRole("switch", { name: "Alert me if it opens" })).toHaveAttribute("aria-checked", "true");
  });

  await test.step("the clock reaches the release; the watch alert goes out and the deputy signs up", async () => {
    await clock.advanceTo(job.id, "release");
    await clock.tick("watch-release");
    await deputy.goto("/alerts");
    await deputy.getByRole("link", { name: new RegExp(`Now open for sign-up: ${title}`) }).click();
    await expect(deputy.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await deputy.getByRole("button", { name: "Sign up for Deputy Sheriff" }).click();
    await deputy.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and sign up" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();
  });

  await test.step("the vendor sees who is coming", async () => {
    await vendor.goto(`/vendor/details/${job.id}`);
    await expect(vendor.getByRole("main")).toContainText(agency.deputy.name);
  });

  await test.step("after the detail ends the deputy bills 30 minutes over, with a reason and the W-9", async () => {
    await clock.advanceTo(job.id, "end", 60);
    await deputy.goto("/billing");
    await deputy.getByRole("article", { name: `${agency.vendor.name}, ${title}` }).getByRole("link", { name: "Review and send invoice" }).click();
    await expect(deputy.getByRole("heading", { level: 1, name: "Bill this detail" })).toBeVisible();
    const end = deputy.getByLabel("End", { exact: true });
    await end.fill(laterLocalInput(await end.inputValue(), 30));
    await deputy.getByRole("button", { name: "Vendor asked me to stay" }).click();
    await deputy.getByLabel("Attach my W-9").check();
    await deputy.getByRole("button", { name: "Submit for review" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "Invoice sent to a coordinator for review." })).toBeVisible();
  });

  await test.step("the coordinator reviews it and sends it; the vendor's email carries the invoice and the W-9", async () => {
    await coordinator.goto("/coordinate");
    const row = coordinator.getByRole("region", { name: "Invoices to review" }).getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText("Vendor asked me to stay");
    await row.getByRole("button", { name: "Approve and send" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Invoice approved and sent to the vendor." })).toBeVisible();
    const since = mail.mark();
    await clock.deliver();
    const sent = mail.find({ to: agency.vendor.billingEmail, since });
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments).toHaveLength(2);
    expect(sent[0].attachments).toContain(`W-9 ${agency.deputy.name}.pdf`);
    expect(sent[0].text).toContain("$292.50");
  });

  await test.step("the vendor marks it paid; the deputy confirms the money arrived", async () => {
    await vendor.goto("/vendor/invoices");
    const card = vendor.getByRole("article").filter({ hasText: title });
    await card.getByRole("button", { name: /^Mark paid/ }).click();
    await card.getByLabel("Date paid").fill(agencyDay(new Date()));
    await card.getByLabel("Method").selectOption({ label: "Check mailed" });
    await card.getByLabel("Check or reference number").fill("1042");
    await card.getByRole("button", { name: "Record payment" }).click();
    await expect(card.getByRole("status")).toContainText("Marked paid. The deputy confirms when the money arrives.");

    await deputy.goto("/billing?tab=waiting");
    const waiting = deputy.getByRole("article").filter({ hasText: agency.vendor.name });
    await expect(waiting).toContainText("Vendor reports paid");
    await waiting.getByRole("button", { name: /^Mark received/ }).click();
    await waiting.getByLabel("Method").selectOption({ label: "Check mailed" });
    await waiting.getByRole("button", { name: "Record payment" }).click();
    // Both sides have marked it paid, so it leaves Waiting.
    await expect(deputy.getByRole("heading", { name: "Nothing waiting" })).toBeVisible();
    await deputy.goto("/billing?tab=paid");
    await expect(deputy.getByRole("article").filter({ hasText: agency.vendor.name })).toContainText("Paid");
  });

  await test.step("the detail is Closed for staff", async () => {
    for (const staff of [coordinator, admin]) {
      await staff.goto(`/coordinate/details/${job.id}`);
      await expect(staff.getByRole("main").getByText("Closed", { exact: true })).toBeVisible();
    }
  });
});
