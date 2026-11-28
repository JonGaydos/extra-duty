import { DESKTOP, agencyAt, expect, one, sql, test } from "../fixtures";

const HOUR = 3_600_000;

/**
 * Detail reminders (owner request 2026-11-27): a coordinator gives one detail its own reminder time and a note in Edit
 * detail, the worker's reminder tick emails the deputy on it once with the description and the note, and the agency
 * default is a set of checkboxes under Management, Reminders and locks.
 */
test("a coordinator sets a detail's reminder time and note, and the deputy on it is reminded once", async ({ agency, session, mail, clock }) => {
  const title = `Harbor fireworks ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(5, 19) });
  await sql("update jobs set description = $2 where id = $1", [job.id, "Crowd control on the pier."]);
  await agency.signUp(job, agency.deputy);
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });

  await test.step("Edit detail: different times for this detail, 2 hours before, with a note", async () => {
    await coordinator.goto(`/jobs/${job.id}?tab=manage`);
    await coordinator.getByRole("button", { name: "Edit detail" }).click();
    const form = coordinator.getByRole("form", { name: "Edit detail" });
    await expect(form.getByRole("radio", { name: /^Agency times: 72 and 24 hours before/ })).toBeChecked();
    await form.getByLabel("Different times for this detail").check();
    await form.getByRole("checkbox", { name: "72 hours before", exact: true }).uncheck();
    await form.getByRole("checkbox", { name: "24 hours before", exact: true }).uncheck();
    await form.getByRole("checkbox", { name: "2 hours before", exact: true }).check();
    await form.getByLabel("Reminder note").fill("Meet at the harbor master's office.");
    await form.getByRole("button", { name: "Save changes" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    const row = await one<{ reminder_hours: number[]; reminder_note: string }>("select reminder_hours, reminder_note from jobs where id = $1", [job.id]);
    expect(row).toEqual({ reminder_hours: [2], reminder_note: "Meet at the harbor master's office." });
  });

  await test.step("the reminder goes out at its time, once, with the description and the note", async () => {
    const since = mail.mark();
    await clock.tick("detail-reminders", new Date(job.startAt.getTime() - 24 * HOUR + 60_000));
    await clock.tick("detail-reminders", new Date(job.startAt.getTime() - 2 * HOUR + 60_000));
    await clock.tick("detail-reminders", new Date(job.startAt.getTime() - 2 * HOUR + 120_000));
    await clock.deliver();
    const m = await mail.waitFor({ to: agency.deputy.email, subject: new RegExp(`^Reminder: Detail #${job.number} `), since });
    expect(m.text).toContain("About the detail: Crowd control on the pier.");
    expect(m.text).toContain("Note: Meet at the harbor master's office.");
    expect(m.text).toContain("It starts in 2 hours.");
    expect(mail.find({ to: agency.deputy.email, subject: /^Reminder: Detail/, since })).toHaveLength(1);
  });

  await test.step("the agency times are checkboxes under Reminders and locks", async () => {
    await coordinator.goto("/admin/settings/reminders");
    const group = coordinator.getByRole("group", { name: "Remind assigned people before a detail starts" });
    await expect(group.getByRole("checkbox", { name: "72 hours before", exact: true })).toBeChecked();
    await expect(group.getByRole("checkbox", { name: "48 hours before", exact: true })).not.toBeChecked();
    await expect(group.getByRole("checkbox", { name: "24 hours before", exact: true })).toBeChecked();
  });
});
