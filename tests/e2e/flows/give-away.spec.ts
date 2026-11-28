import { DESKTOP, PHONE, agencyAt, expect, one, test } from "../fixtures";

/**
 * Giving a spot away (owner decision 2026-11-27): Carmen offers her spot and stays on it, the panel shows one state
 * and the prompt to let others know, Send a message opens New message about the detail, Jordan takes over and
 * replaces her, and the coordinator sees the history.
 */
test("Carmen gives her spot away and Jordan takes it over", async ({ agency, session }) => {
  const title = `Riverwalk concert ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(4, 18) });
  const carmen = await agency.addDeputy(`Carmen Caldwell ${agency.tag}`);
  const jordan = await agency.addDeputy(`Jordan Example ${agency.tag}`);
  const mine = await agency.signUp(job, carmen);

  const page = await session(carmen, { viewport: PHONE });

  await test.step("Carmen offers the spot after reading the terms, and stays on it", async () => {
    await page.goto(`/jobs/${job.id}`);
    const state = page.getByTestId("sign-up-state");
    await expect(state).toHaveText("You are signed up for this detail.");
    await page.getByRole("button", { name: "Give away this spot" }).click();
    await expect(page.getByText("You stay on this detail until another deputy takes your spot. If nobody does, you are still expected to work it.")).toBeVisible();
    await page.getByLabel("Reason").fill("Family event");
    await page.getByRole("button", { name: "Give away this spot" }).click();
    await expect(state).toHaveText(/Offered: waiting for someone to take over\./);
    // Exactly one state: never "signed up" and "offered" together.
    await expect(page.getByTestId("sign-up-state")).toHaveCount(1);
    await expect(page.getByText("You are signed up for this detail.")).toHaveCount(0);
    await expect(page.getByText("Would you like to let others know this spot is available?")).toBeVisible();
    await expect(page.getByRole("button", { name: "Withdraw offer" })).toBeVisible();
    await expect(page.getByRole("table", { name: "Roster" }).getByText("Offered")).toBeVisible();
    expect((await one<{ status: string }>("select status from assignments where id = $1", [mine])).status).toBe("signed_up");
  });

  await test.step("Send a message opens New message with this detail under About a detail and no recipients", async () => {
    await page.reload();
    await expect(page.getByTestId("offer-message-link")).toBeVisible();
    await page.getByTestId("offer-message-link").click();
    await expect(page).toHaveURL(/\/messages\/new\?about=/);
    await expect(page.getByLabel("About a detail")).toHaveValue(job.id);
    await expect(page.getByRole("button", { name: /^Remove Everyone on/ })).toHaveCount(0);
  });

  await test.step("Home still lists the offered spot under Up next", async () => {
    await page.goto("/home");
    const upNext = page.getByRole("list", { name: "Up next" });
    await expect(upNext.getByText(title)).toBeVisible();
    await expect(upNext.getByText("Offered", { exact: true })).toBeVisible();
  });

  await test.step("Jordan takes over the spot and replaces Carmen", async () => {
    const other = await session(jordan, { viewport: DESKTOP });
    await other.goto(`/jobs/${job.id}`);
    await expect(other.getByText("A deputy offers this spot. Taking it over replaces them on the detail.")).toBeVisible();
    await other.getByRole("button", { name: "Take over this spot" }).click();
    await other.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and take over" }).click();
    await expect(other.getByTestId("sign-up-state")).toHaveText("You are signed up for this detail.");
    expect((await one<{ status: string }>("select status from assignments where id = $1", [mine])).status).toBe("canceled");
  });

  await test.step("Carmen's panel shows the one new state, and the detail leaves Up next", async () => {
    await page.goto(`/jobs/${job.id}`);
    await expect(page.getByTestId("sign-up-state")).toHaveText(`Taken over by Jordan Example ${agency.tag}. You are no longer on this detail.`);
    await expect(page.getByTestId("sign-up-state")).toHaveCount(1);
    await page.goto("/home");
    await expect(page.getByRole("list", { name: "Up next" }).getByText(title)).toHaveCount(0);
  });

  await test.step("the coordinator sees Gave away with the offer and who took it over", async () => {
    const coord = await session(agency.coordinator, { viewport: DESKTOP });
    await coord.goto(`/jobs/${job.id}?tab=manage`);
    const history = coord.getByRole("list", { name: "Sign-up history" });
    await expect(history.getByText("Gave away")).toBeVisible();
    await expect(history.getByText(new RegExp(`Offered by Carmen Caldwell ${agency.tag} on .+: Family event`))).toBeVisible();
    await expect(history.getByText(`Taken over by Jordan Example ${agency.tag}`, { exact: true })).toBeVisible();
  });
});
