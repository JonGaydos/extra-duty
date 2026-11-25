import { DESKTOP, PHONE, agencyAt, expect, pdf, test } from "../fixtures";

/**
 * Flow (d): a detail that needs an ops plan. The Incident Commander signs up and submits it, the admin (the agency's
 * ops plan reviewer) denies it with comments, the IC submits a new version, the admin agrees, and once the detail is
 * over the plan is in the library.
 */
test("ops plan required, IC submits, reviewer denies, IC resubmits, reviewer agrees, plan in the library", async ({ agency, session, mail, clock }) => {
  const title = `Mardi Gras parade ${agency.tag}`;
  await agency.settings({ opsPlanReviewerUserIds: [agency.admin.id] });
  const job = await agency.detail({ title, startAt: agencyAt(5, 10), hours: 6, position: "Incident Commander", opsPlanRequired: true });
  const sky = await agency.addDeputy(`Sky Ramirez ${agency.tag}`, { flags: ["Incident Commander"] });

  const ic = await session(sky, { viewport: PHONE });
  const admin = await session(agency.admin, { viewport: DESKTOP });

  await test.step("the IC signs up and submits the plan", async () => {
    await ic.goto(`/jobs/${job.id}`);
    await ic.getByRole("button", { name: "Sign up for Incident Commander" }).click();
    await ic.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and sign up" }).click();
    await expect(ic.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();
    await expect(ic.getByText("Not submitted yet.", { exact: false })).toBeVisible();
    await ic.getByLabel("Ops plan file").setInputFiles(pdf("Parade plan v1"));
    const since = mail.mark();
    await ic.getByRole("button", { name: "Submit ops plan" }).click();
    await expect(ic.getByRole("status").filter({ hasText: "Ops plan submitted for review." })).toBeVisible();
    await expect(ic.getByText("Submitted, waiting for review.", { exact: false })).toBeVisible();
    await clock.deliver();
    await mail.waitFor({ to: agency.admin.email, subject: `Ops plan submitted: job #${job.number}`, since });
  });

  await test.step("the reviewer denies it with comments", async () => {
    await admin.goto("/coordinate/ops-plans");
    const waiting = admin.getByRole("listitem").filter({ hasText: `${title}, version 1` });
    await expect(waiting).toContainText(`by IC ${sky.name}`);
    await waiting.getByLabel("Comments").fill("Add the road closure times and the reunification point.");
    await waiting.getByRole("button", { name: "Deny" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Ops plan denied and sent back to the Incident Commander." })).toBeVisible();
  });

  await test.step("the IC sees the denial and submits a new version", async () => {
    await ic.goto("/alerts");
    await expect(ic.getByRole("main")).toContainText(title);
    await ic.goto(`/jobs/${job.id}`);
    await expect(ic.getByText("Denied. A new version is needed.", { exact: false })).toBeVisible();
    await ic.getByLabel("New version of the ops plan").setInputFiles(pdf("Parade plan v2"));
    await ic.getByRole("button", { name: "Submit new version" }).click();
    await expect(ic.getByRole("status").filter({ hasText: "Ops plan submitted for review." })).toBeVisible();
  });

  await test.step("the reviewer agrees", async () => {
    await admin.goto(`/coordinate/details/${job.id}`);
    await admin.getByRole("button", { name: "Agree" }).click();
    await expect(admin.getByRole("status").filter({ hasText: "Ops plan agreed." })).toBeVisible();
    await ic.reload();
    await expect(ic.getByText("Agreed.", { exact: false })).toBeVisible();
  });

  await test.step("after the detail, the agreed plan is in the library", async () => {
    await clock.advanceTo(job.id, "end", 60);
    await admin.goto(`/coordinate/ops-plans?q=${encodeURIComponent(title)}#library`);
    const row = admin.getByRole("main").getByRole("listitem").filter({ hasText: title });
    await expect(row).toContainText(agency.vendor.name);
    await expect(row.getByRole("link", { name: "Download parade-plan-v2.pdf" })).toBeVisible();
  });
});
