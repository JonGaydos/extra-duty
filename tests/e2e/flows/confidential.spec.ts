import { DESKTOP, PHONE, agencyAt, expect, one, sql, test } from "../fixtures";

/**
 * Confidential details (owner decision 2026-11-27). A coordinator marks a dignitary escort Confidential with a reason
 * and assigns a deputy. The assignment email names only the date. Another deputy and the vendor find nothing: not in
 * the lists, not by its number. The assigned deputy sees it in full with the Confidential chip, and the coordinator
 * sees who opened it and can list only confidential details or hide them.
 */
test("a confidential detail is seen only by staff and the deputy assigned, and every open is logged", async ({ agency, session, mail, clock }) => {
  const title = `Dignitary escort ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(9, 10), releaseAt: null });
  const other = await agency.addDeputy(`Kai Benton ${agency.tag}`);
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });

  await test.step("the coordinator marks it Confidential with a reason; hold and release go away", async () => {
    await coordinator.goto(`/jobs/${job.number}?tab=manage`);
    await coordinator.getByRole("button", { name: "Make it confidential" }).click();
    await coordinator.getByLabel("Reason for making it confidential").fill("Governor's office asked for privacy");
    await coordinator.getByRole("button", { name: "Make it confidential" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Marked confidential." })).toBeVisible();
    await expect(coordinator.getByTestId("manage-detail").getByText("Confidential", { exact: true }).first()).toBeVisible();
    await expect(coordinator.getByRole("button", { name: "Hold" })).toHaveCount(0);
    const audit = await one<{ reason: string }>("select reason from audit_log where action = 'job.confidential_on' and entity_id = $1", [job.id]);
    expect(audit.reason).toBe("Governor's office asked for privacy");
  });

  await test.step("they assign Drew; the email says only that there is a confidential detail on that date", async () => {
    const since = mail.mark();
    await coordinator.getByRole("button", { name: "Assign someone" }).click();
    await coordinator.getByLabel("Person", { exact: true }).selectOption({ label: agency.deputy.name });
    await coordinator.getByRole("button", { name: "Assign", exact: true }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Assigned." })).toBeVisible();
    await clock.deliver();
    const sent = await mail.waitFor({ to: agency.deputy.email, since });
    expect(`${sent.subject} ${sent.text}`).toContain("You were assigned to a confidential detail on");
    expect(`${sent.subject} ${sent.text}`).not.toContain("Dignitary");
    expect(`${sent.subject} ${sent.text}`).not.toContain(agency.vendor.name);
  });

  await test.step("another deputy finds nothing: not in Details, not by its number", async () => {
    const page = await session(other, { viewport: PHONE });
    await page.goto("/jobs?f=1");
    await expect(page.getByRole("main")).not.toContainText(title);
    expect((await page.goto(`/jobs/${job.number}`))?.status()).toBe(404);
    await page.goto(`/jobs?go=${job.number}`);
    await expect(page.getByText(`No detail #${job.number} that you can see.`)).toBeVisible();
  });

  await test.step("the vendor does not see it in the portal", async () => {
    const vendor = await session(agency.vendorLogin, { viewport: DESKTOP });
    await vendor.goto("/vendor");
    await expect(vendor.getByRole("main")).not.toContainText(title);
    expect((await vendor.goto(`/vendor/details/${job.id}`))?.status()).toBe(404);
  });

  await test.step("Drew sees it in full, marked Confidential", async () => {
    const drew = await session(agency.deputy, { viewport: PHONE });
    await drew.goto(`/jobs/${job.number}`);
    await expect(drew.getByRole("heading", { level: 1, name: title })).toBeVisible();
    await expect(drew.getByText("Confidential", { exact: true }).first()).toBeVisible();
  });

  await test.step("the coordinator sees who opened it, and can list only confidential details or hide them", async () => {
    await coordinator.goto(`/jobs/${job.number}?tab=manage`);
    const log = coordinator.getByRole("region", { name: "Who opened it" });
    await expect(log).toContainText(agency.deputy.name);
    await expect(log).toContainText(agency.coordinator.name);
    const views = await sql<{ actor: string }>("select actor_user_id as actor from audit_log where action = 'job.confidential_view' and entity_id = $1", [job.id]);
    expect(views.map((v) => v.actor)).toEqual(expect.arrayContaining([agency.deputy.id, agency.coordinator.id]));
    await coordinator.goto("/jobs?f=1&conf=only");
    await expect(coordinator.getByRole("main")).toContainText(title);
    await coordinator.goto("/jobs?f=1&conf=hide");
    await expect(coordinator.getByRole("main")).not.toContainText(title);
  });
});
