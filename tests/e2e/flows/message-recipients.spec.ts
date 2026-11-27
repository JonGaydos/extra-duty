import { DESKTOP, expect, sql, test } from "../fixtures";

/**
 * Owner bug report 2026-11-27: a chosen person stayed listed after switching the To field to Everyone. "Send to" is now
 * Everyone or Choose recipients; Everyone replaces the chips (with Undo), and the message goes to everyone once each.
 */
test("Send to: Everyone replaces the chosen recipients, Undo brings them back, and everyone gets one copy", async ({ agency, session }) => {
  const robin = await agency.addDeputy(`Robin Vale ${agency.tag}`);
  const page = await session(agency.coordinator, { viewport: DESKTOP });
  await page.goto("/messages/new");

  await test.step("choose Robin, then switch to Everyone: the chip is replaced, with Undo", async () => {
    await page.getByLabel("Name").fill(robin.name);
    await page.getByRole("button", { name: `Add ${robin.name}` }).click();
    const chips = page.getByRole("list", { name: "Recipients" });
    await expect(chips).toContainText(robin.name);
    await page.getByRole("radio", { name: /^Everyone \(\d+ (person|people)\)$/ }).check();
    await expect(page.getByRole("list", { name: "Recipients" })).toHaveCount(0);
    await expect(page.getByText("Replaced 1 recipient with everyone.")).toBeVisible();
    await page.getByRole("button", { name: "Undo" }).click();
    await expect(page.getByRole("radio", { name: "Choose recipients" })).toBeChecked();
    await expect(chips).toContainText(robin.name);
    await page.getByRole("radio", { name: /^Everyone/ }).check();
  });

  await test.step("the message goes to everyone, once each, Robin included", async () => {
    await page.getByLabel("Subject").fill(`Parking ${agency.tag}`);
    await page.getByLabel("Message").fill("Use lot B on Friday.");
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(page).toHaveURL(/\/messages\/[0-9a-f-]+$/);
    const rows = await sql<{ user_id: string; n: string }>(
      "select r.user_id, count(*) as n from message_recipients r join messages m on m.id = r.message_id where m.subject = $1 group by r.user_id",
      [`Parking ${agency.tag}`],
    );
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.every((r) => Number(r.n) === 1)).toBe(true);
    expect(rows.map((r) => r.user_id)).toContain(robin.id);
  });
});
