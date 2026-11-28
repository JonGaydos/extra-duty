import { DESKTOP, PHONE, agencyAt, expect, sql, test } from "../fixtures";

/**
 * Owner request 2026-11-27: a coordinator sends a message that requires acknowledgement, with a due date and the
 * sign-up lock. The deputy sees the banner on Home and the bar on other pages, can acknowledge only after reaching the
 * end of the message, and the lock applies after the due date until they do. The coordinator tracks and reminds.
 */
test("a message that requires acknowledgement: banner, scroll to the end, lock after the due date, tracking", async ({ agency, session }) => {
  const sam = await agency.addDeputy(`Sam Ortega ${agency.tag}`);
  const kit = await agency.addDeputy(`Kit Moreno ${agency.tag}`);
  const subject = `Radio plan ${agency.tag}`;
  const next = await agency.detail({ title: `Pier lot ${agency.tag}`, startAt: agencyAt(6, 8) });
  // Long enough that the end of the message is below the fold on a phone.
  const body = Array.from({ length: 40 }, (_, i) => `Step ${i + 1}. Check in on the detail channel and confirm with dispatch.`).join("\n\n");
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });
  const deputy = await session(sam, { viewport: PHONE });

  await test.step("the coordinator requires acknowledgement with a due date and the lock", async () => {
    await coordinator.goto("/messages/new");
    for (const p of [sam, kit]) {
      await coordinator.getByLabel("Name").fill(p.name);
      await coordinator.getByRole("button", { name: `Add ${p.name}` }).click();
    }
    await coordinator.getByLabel("Subject").fill(subject);
    await coordinator.getByLabel("Message").fill(body);
    await coordinator.getByRole("checkbox", { name: "Require acknowledgement" }).check();
    const lock = coordinator.getByRole("checkbox", { name: "Lock sign-ups if not acknowledged by the due date" });
    await expect(lock).toBeDisabled();
    const due = agencyAt(5, 12);
    await coordinator.getByLabel("Due date", { exact: true }).fill(due.toLocaleDateString("en-CA", { timeZone: "America/Chicago" }));
    await lock.check();
    await coordinator.getByRole("button", { name: "Send message" }).click();
    await expect(coordinator).toHaveURL(/\/messages\/[0-9a-f-]+$/);
    await expect(coordinator.getByTestId("ack-tracking")).toContainText("Acknowledged 0 of 2");
  });

  await test.step("Home shows the banner; other pages show the bar", async () => {
    await deputy.goto("/home");
    await expect(deputy.getByTestId("ack-banner")).toContainText(`Important message from ${agency.coordinator.name}: ${subject}. Read and acknowledge.`);
    await deputy.goto("/jobs");
    await expect(deputy.getByTestId("ack-bar")).toContainText(subject);
  });

  await test.step("after the due date, sign-ups lock until it is acknowledged", async () => {
    await sql("update messages set ack_due_at = now() - interval '1 hour' where subject = $1", [subject]);
    await deputy.goto(`/jobs/${next.id}`);
    await expect(deputy.getByText(`Acknowledge the message "${subject}" to sign up again`)).toBeVisible();
    await expect(deputy.getByRole("button", { name: "Sign up for Deputy Sheriff" })).toBeDisabled();
  });

  await test.step("the button stays disabled until the end of the message is reached", async () => {
    await deputy.goto("/home");
    await deputy.getByTestId("ack-banner").getByRole("link", { name: "Open message" }).click();
    const button = deputy.getByRole("button", { name: "I have read and understand" });
    await expect(button).toBeDisabled();
    await button.scrollIntoViewIfNeeded();
    await expect(button).toBeEnabled();
    await button.click();
    await expect(deputy.getByText(/^You acknowledged this message/)).toBeVisible();
    const [row] = await sql<{ acknowledged_at: Date | null }>(
      "select r.acknowledged_at from message_recipients r join messages m on m.id = r.message_id where m.subject = $1 and r.user_id = $2",
      [subject, sam.id],
    );
    expect(row.acknowledged_at).not.toBeNull();
  });

  await test.step("the banner, the bar and the lock are gone", async () => {
    await deputy.goto("/home");
    await expect(deputy.getByTestId("ack-banner")).toHaveCount(0);
    await deputy.goto(`/jobs/${next.id}`);
    await expect(deputy.getByTestId("ack-bar")).toHaveCount(0);
    await expect(deputy.getByText(`Acknowledge the message "${subject}" to sign up again`)).toHaveCount(0);
  });

  await test.step("the coordinator tracks it, reminds Kit, exports the CSV and sees it on To-do", async () => {
    await coordinator.reload();
    const card = coordinator.getByTestId("ack-tracking");
    await expect(card).toContainText("Acknowledged 1 of 2");
    await expect(card).toContainText(kit.name);
    await card.getByRole("button", { name: "Remind those who haven't" }).click();
    await expect(card.getByText("Reminded 1 person.")).toBeVisible();
    const href = await card.getByRole("link", { name: "Download CSV" }).getAttribute("href");
    const csv = await coordinator.request.get(href!);
    expect(csv.status()).toBe(200);
    const text = await csv.text();
    expect(text).toContain(`${sam.name},`);
    expect(text).toContain("Not acknowledged");
    await coordinator.goto("/coordinate");
    await expect(coordinator.getByRole("main").getByText(`Message not acknowledged: ${subject}`)).toBeVisible();
  });
});
