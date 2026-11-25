import { PHONE, agencyAt, expect, one, test } from "../fixtures";

/**
 * Flow (b): a deputy cancels a full detail, the spot goes to backup #1 for the backup window, the window runs out on
 * the clock, backup #2 gets their turn and takes the spot.
 */
test("cancel, backup window, backup claims", async ({ agency, session, mail, clock }) => {
  const title = `Harbor fireworks ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(3, 18) });
  const kai = await agency.addDeputy(`Kai Benton ${agency.tag}`);
  const noor = await agency.addDeputy(`Noor Haddad ${agency.tag}`);
  const holder = await agency.signUp(job, agency.deputy);
  await agency.signUp(job, kai, 1);

  const drew = await session(agency.deputy, { viewport: PHONE });
  const second = await session(noor, { viewport: PHONE });
  const first = await session(kai, { viewport: PHONE });

  await test.step("the detail is full, so Noor joins the backup list as #2", async () => {
    await second.goto(`/jobs/${job.id}`);
    await second.getByRole("button", { name: "Join backup list" }).click();
    await second.getByRole("dialog", { name: "Before you sign up" }).getByRole("button", { name: "Accept and join backup list" }).click();
    await expect(second.getByRole("status").filter({ hasText: "You are backup #2." })).toBeVisible();
  });

  await test.step("Drew cancels; the spot is offered to backup #1 only", async () => {
    await drew.goto(`/jobs/${job.id}`);
    await drew.getByLabel("Reason for canceling").fill("Family emergency");
    await drew.getByRole("button", { name: "Cancel my sign-up" }).click();
    await expect(drew.getByRole("status").filter({ hasText: "Your sign-up is canceled." })).toBeVisible();
    expect((await one<{ status: string }>("select status from assignments where id = $1", [holder])).status).toBe("canceled");
    // While backup #1's window runs, nobody else can take the spot, Drew included, and the panel says why up front.
    await expect(drew.getByText("Backups have first chance at this spot")).toBeVisible();
    await expect(drew.getByRole("button", { name: /^All checks passed/ })).toHaveCount(0);
    await expect(drew.getByRole("button", { name: "Sign up for Deputy Sheriff" })).toBeDisabled();

    const since = mail.mark();
    await clock.deliver();
    await mail.waitFor({ to: kai.email, subject: `Spot available: ${title}`, since });
    expect(mail.find({ to: noor.email, since })).toHaveLength(0);

    await second.reload();
    await expect(second.getByText("You are on this detail: Backup #2.")).toBeVisible();
    await expect(second.getByRole("button", { name: "Take the open spot" })).toHaveCount(0);
    await first.goto("/alerts");
    await expect(first.getByRole("main")).toContainText(`Spot available: ${title}`);
    await first.goto(`/jobs/${job.id}`);
    await expect(first.getByRole("button", { name: "Take the open spot" })).toBeVisible();
  });

  await test.step("Kai lets the 30-minute window run out; the turn passes to Noor, who takes the spot", async () => {
    const offer = await one<{ ends_at: Date }>("select ends_at from spot_offers where job_position_id = $1 and status = 'open'", [job.positionId]);
    const since = mail.mark();
    await clock.tick("backup-offer", new Date(offer.ends_at.getTime() + 60_000));
    await clock.deliver();
    await mail.waitFor({ to: noor.email, subject: `Spot available: ${title}`, since });

    await first.reload();
    await expect(first.getByRole("button", { name: "Take the open spot" })).toHaveCount(0);
    await second.reload();
    await second.getByRole("button", { name: "Take the open spot" }).click();
    await expect(second.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();
    await expect(second.getByText("You are signed up for this detail.")).toBeVisible();
  });

  const roster = await one<{ statuses: string }>(
    "select string_agg(u.email || '=' || a.status || coalesce('#' || a.backup_position, ''), ',' order by u.email) as statuses from assignments a join users u on u.id = a.user_id where a.job_id = $1",
    [job.id],
  );
  expect(roster.statuses.split(",").sort()).toEqual([`${agency.deputy.email}=canceled`, `${kai.email}=backup#1`, `${noor.email}=signed_up`].sort());
});
