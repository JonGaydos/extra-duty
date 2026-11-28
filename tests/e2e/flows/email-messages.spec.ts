import { DESKTOP, expect, one, test } from "../fixtures";

/**
 * Editable email messages (owner decision 2026-11-27): a coordinator opens the detail reminder under Management,
 * Reminders and locks, Email messages, inserts a placeholder, sees the preview, sends a test to themselves, saves it
 * (audited), and puts it back to the default. A coordinator sees the sign-in code message read-only.
 */
test("a coordinator edits the detail reminder email, sends a test and resets it", async ({ agency, session, mail }) => {
  const page = await session(agency.coordinator, { viewport: DESKTOP });

  await test.step("Email messages lists every email in groups with who and when", async () => {
    await page.goto("/admin/settings/reminders");
    const section = page.getByRole("region", { name: "Email messages" });
    await expect(section.getByRole("heading", { name: "Detail reminders" })).toBeVisible();
    await expect(section.getByRole("heading", { name: "Sign-in and account" })).toBeVisible();
    await section.getByRole("link", { name: "Detail reminder", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Detail reminder", level: 1 })).toBeVisible();
  });

  const body = page.getByLabel("Message", { exact: true });
  await test.step("insert a placeholder, refuse an unknown one, and preview", async () => {
    await body.fill("Hello {{person.firstName}}.\n\nDetail #{{detail.number}} starts soon.\n\nNote: {{reminder.note}}\n\nBring the radio. {{invoice.number}}");
    await expect(page.getByText(/\{\{invoice\.number\}\} is not a placeholder this message can use/)).toBeVisible();
    await expect(page.getByRole("button", { name: "Save message" })).toBeDisabled();
    await body.fill("Hello {{person.firstName}}.\n\nDetail #{{detail.number}} starts soon.\n\nNote: {{reminder.note}}\n\nBring the radio. ");
    await page.getByRole("button", { name: "Insert Location" }).click();
    await expect(body).toHaveValue(/Bring the radio\. \{\{detail\.location\}\}/);
    const preview = page.getByRole("region", { name: "Preview" });
    await expect(preview).toContainText("Hello Jordan.");
    await expect(preview).toContainText("Note: Check in with the gate officer.");
    await expect(preview).toContainText("Bring the radio. North Field, 100 Main St, Springfield");
  });

  await test.step("send me a test goes to the coordinator's own address", async () => {
    const since = mail.mark();
    await page.getByRole("button", { name: "Send me a test" }).click();
    await expect(page.getByRole("status").filter({ hasText: `Test sent to ${agency.coordinator.email}.` })).toBeVisible();
    const m = await mail.waitFor({ to: agency.coordinator.email, subject: /^Test: Reminder: Detail #1042 /, since });
    expect(m.text).toContain("Bring the radio. North Field, 100 Main St, Springfield");
  });

  await test.step("save it: changed by the coordinator, audited, then reset to the default", async () => {
    await page.getByRole("button", { name: "Save message" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Message saved." })).toBeVisible();
    await expect(page.getByTestId("message-changed")).toContainText(`Changed by ${agency.coordinator.name} on `);
    const audit = await one<{ n: string }>("select count(*) as n from audit_log where action = 'email_message.update' and entity_id = 'job.reminder' and actor_user_id = $1", [agency.coordinator.id]);
    expect(audit.n).toBe("1");
    await page.getByRole("button", { name: "Reset to default" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Message reset to the default." })).toBeVisible();
    await expect(body).toHaveValue(/^Reminder: you are on Detail #\{\{detail\.number\}\}/);
    await expect(page.getByTestId("message-changed")).toHaveText("The default message. Nobody has changed it.");
  });

  await test.step("the sign-in code message is read-only for a coordinator", async () => {
    await page.goto("/admin/settings/reminders/email/auth.sign_in_code");
    await expect(page.getByText("Only admins can change sign-in, invitation, password reset and security emails.")).toBeVisible();
    await expect(page.getByLabel("Message", { exact: true })).toHaveAttribute("readonly", "");
    await expect(page.getByRole("button", { name: "Save message" })).toHaveCount(0);
  });
});
