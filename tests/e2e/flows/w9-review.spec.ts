import { DESKTOP, PHONE, agencyAt, expect, pdf, sql, test } from "../fixtures";

/**
 * Owner decisions 2026-11-27: a deputy without an approved W-9 is sign-up locked; their upload waits on the
 * coordinator's To-do as "W-9 to review"; a rejection says why; the approval records the signature date and form
 * revision, the deputy is told, and sign-up opens. A staff upload for the person and a renewal request are covered too.
 */
test("W-9 review: locked until approved, rejected with a reason, approved, then sign-up opens", async ({ agency, session }) => {
  const title = `Pier fireworks ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(5, 19) });
  const kai = await agency.addDeputy(`Kai Brennan ${agency.tag}`, { w9: false });
  const deputy = await session(kai, { viewport: PHONE });
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });

  await test.step("without a W-9 the deputy cannot sign up, and the rule says why", async () => {
    await deputy.goto(`/jobs/${job.id}`);
    await expect(deputy.getByText("Your W-9 needs to be approved before you can sign up. Upload it in Profile")).toBeVisible();
    await expect(deputy.getByRole("button", { name: "Sign up for Deputy Sheriff" })).toBeDisabled();
  });

  await test.step("the deputy uploads a W-9; it is pending review", async () => {
    await deputy.goto("/profile");
    await deputy.getByLabel("Upload your W-9").setInputFiles(pdf(`W-9 ${kai.name}`));
    await deputy.getByRole("button", { name: "Upload W-9" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "W-9 uploaded. It waits for review." })).toBeVisible();
    await expect(deputy.locator("#w9")).toContainText("Pending review");
  });

  await test.step("the coordinator rejects it from To-do with a reason", async () => {
    await coordinator.goto("/coordinate");
    const section = coordinator.getByRole("region", { name: /^W-9 to review/ });
    await section.getByRole("link", { name: `Review W-9, ${kai.name}` }).click();
    await expect(coordinator).toHaveURL(/\/admin\/users\/.+#w9$/);
    const card = coordinator.locator("#w9");
    await card.getByRole("button", { name: "Reject" }).click();
    await card.getByLabel("Reason").fill("Line 2 missing");
    await card.getByRole("button", { name: "Reject W-9" }).click();
    await expect(coordinator.getByText("W-9 not approved. They were told why and asked for a new one.")).toBeVisible();
    await expect(card).toContainText("Not approved: Line 2 missing");
  });

  await test.step("the deputy sees why and uploads again", async () => {
    await deputy.goto("/alerts");
    await expect(deputy.getByRole("main")).toContainText("Line 2 missing");
    await deputy.goto("/profile");
    await expect(deputy.locator("#w9")).toContainText("Not approved: Line 2 missing");
    await deputy.getByLabel("Replace your W-9").setInputFiles(pdf(`W-9 ${kai.name} fixed`));
    await deputy.getByRole("button", { name: "Upload W-9" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "W-9 uploaded." })).toBeVisible();
  });

  await test.step("the coordinator approves it with the signature date and revision", async () => {
    await coordinator.goto("/coordinate");
    await coordinator.getByRole("region", { name: /^W-9 to review/ }).getByRole("link", { name: `Review W-9, ${kai.name}` }).click();
    const card = coordinator.locator("#w9");
    await card.getByRole("button", { name: "Approve" }).click();
    await card.getByLabel("Signature date").fill(`${new Date().getFullYear()}-01-02`);
    await card.getByLabel("IRS form revision").fill("March 2024");
    await card.getByRole("button", { name: "Approve W-9" }).click();
    await expect(coordinator.getByText("W-9 approved. They were told.")).toBeVisible();
    await expect(card).toContainText("Approved");
    await expect(card).toContainText("March 2024 form");
  });

  await test.step("the deputy can sign up now", async () => {
    await deputy.goto(`/jobs/${job.id}`);
    await expect(deputy.getByText(/W-9 needs to be approved/)).toHaveCount(0);
    await deputy.getByRole("button", { name: "Sign up for Deputy Sheriff" }).click();
    await deputy.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and sign up" }).click();
    await expect(deputy.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();
  });

  await test.step("every view, approval and rejection is in the audit log", async () => {
    const rows = await sql<{ action: string }>(
      "select a.action from audit_log a join w9s w on w.id = a.entity_id where w.user_id = $1 and a.action in ('w9.read', 'w9.approve', 'w9.reject') order by a.at",
      [kai.id],
    );
    expect(rows.map((r) => r.action)).toEqual(expect.arrayContaining(["w9.reject", "w9.approve"]));
  });
});

test("staff upload a W-9 for a person and ask for a new one by a due date", async ({ agency, session }) => {
  const ana = await agency.addDeputy(`Ana Moss ${agency.tag}`, { w9: false });
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });

  await test.step("the coordinator uploads a W-9 for the person; it starts pending", async () => {
    await coordinator.goto(`/admin/users/${ana.id}#w9`);
    const card = coordinator.locator("#w9");
    await card.getByLabel(`Upload a W-9 for ${ana.name}`).setInputFiles(pdf(`Paper W-9 ${ana.name}`));
    await card.getByRole("button", { name: "Upload W-9" }).click();
    await expect(card.getByRole("status").filter({ hasText: "W-9 uploaded. It waits for review." })).toBeVisible();
    await expect(card).toContainText(`by ${agency.coordinator.name}`);
    await expect(card).toContainText("Pending review");
  });

  await test.step("the coordinator asks the person for a new W-9 and sees the request", async () => {
    await coordinator.locator("#w9").getByRole("link", { name: `Ask ${ana.name} for a new W-9` }).click();
    await expect(coordinator).toHaveURL(/\/admin\/w9\?person=/);
    await expect(coordinator.getByLabel("Ask", { exact: true })).toHaveValue("person");
    const due = new Date(Date.now() + 20 * 86_400_000).toISOString().slice(0, 10);
    await coordinator.getByLabel("Due date").fill(due);
    await coordinator.getByLabel("Note").fill("New IRS revision");
    await coordinator.getByRole("button", { name: "Send request" }).click();
    await expect(coordinator.getByText(`Request sent: ${ana.name}.`)).toBeVisible();
    const request = coordinator.getByRole("region", { name: /^Requests/ }).getByRole("listitem").filter({ hasText: ana.name }).first();
    // The upload came before the request, so it does not count toward it.
    await expect(request).toContainText("1 missing");
  });
});
