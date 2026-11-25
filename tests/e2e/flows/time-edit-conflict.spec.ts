import { DESKTOP, PHONE, agencyAt, expect, one, test } from "../fixtures";

/**
 * A coordinator moves the end time of a detail whose deputy is also on a later detail that evening. The overlap is
 * listed, the save waits for a confirmed override with a reason, and the deputy is told the detail changed.
 */
test("time edit that double-books the assigned deputy: the conflict shows and the override needs a reason", async ({ agency, session }) => {
  const first = await agency.detail({ title: `School dance gate ${agency.tag}`, startAt: agencyAt(8, 17) });
  const second = await agency.detail({ title: `School dance lot ${agency.tag}`, startAt: agencyAt(8, 21, 30), hours: 2 });
  await agency.signUp(first, agency.deputy);
  await agency.signUp(second, agency.deputy);
  const reason = "Drew leaves the gate early; the lot starts late";

  const coordinator = await session(agency.coordinator, { viewport: PHONE });
  await coordinator.goto(`/coordinate/details/${first.id}`);
  const form = coordinator.getByRole("form", { name: "Quick edit" });
  await form.getByLabel("End time").fill("22:30");
  await form.getByRole("button", { name: "Save changes" }).click();

  await test.step("the conflict is listed and nothing is saved", async () => {
    const conflicts = coordinator.getByTestId("quick-conflicts");
    await expect(conflicts).toContainText(`${agency.deputy.name} on #${first.number}`);
    await expect(conflicts).toContainText(`Overlaps job #${second.number}`);
    expect((await one<{ end: string }>("select to_char(end_at at time zone 'America/Chicago', 'HH24:MI') as end from jobs where id = $1", [first.id])).end).toBe("21:00");
  });

  await test.step("the override needs a reason", async () => {
    await form.getByLabel("Save anyway: I confirm these deputies stay on with the conflicts above").check();
    await expect(form.getByRole("button", { name: /^Save (changes|with override)$/ })).toBeDisabled();
    await form.getByLabel("Reason for the override").fill(reason);
    await form.getByRole("button", { name: "Save with override" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
    expect((await one<{ end: string }>("select to_char(end_at at time zone 'America/Chicago', 'HH24:MI') as end from jobs where id = $1", [first.id])).end).toBe("22:30");
    expect((await one<{ reason: string }>("select reason from audit_log where entity_id = $1 and action = 'job.schedule_conflict_override'", [first.id])).reason).toBe(reason);
  });

  await test.step("the deputy is told the detail changed", async () => {
    const deputy = await session(agency.deputy, { viewport: DESKTOP });
    await deputy.goto("/alerts");
    await expect(deputy.getByRole("main")).toContainText(`Detail changed: ${first.title}`);
  });
});
