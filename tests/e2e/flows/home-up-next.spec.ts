import { DESKTOP, agencyAt, expect, sql, test } from "../fixtures";

/**
 * Home's Up next lists only what the person still works. Canceled, removed and job-canceled sign-ups stay out of it
 * (they remain on Details with My details and the Canceled filter); a backup spot shows under On backup.
 */
test("Up next keeps to the details a deputy works, with backups apart and history on Details", async ({ agency, session }) => {
  const me = agency.deputy;
  const t = (name: string) => `${name} ${agency.tag}`;
  const working = await agency.detail({ title: t("Boat ramp watch"), startAt: agencyAt(3, 8) });
  const backup = await agency.detail({ title: t("Pier lights"), startAt: agencyAt(4, 8) });
  const dropped = await agency.detail({ title: t("Market gate"), startAt: agencyAt(5, 8) });
  const removed = await agency.detail({ title: t("Parking lot B"), startAt: agencyAt(6, 8) });
  const jobGone = await agency.detail({ title: t("Rained out fair"), startAt: agencyAt(7, 8) });
  await agency.signUp(working, me);
  await agency.signUp(backup, me, 1);
  for (const d of [dropped, removed, jobGone]) await agency.signUp(d, me);
  await sql("update assignments set status = 'canceled', removal_reason = null where job_id = $1 and user_id = $2", [dropped.id, me.id]);
  await sql("update assignments set status = 'removed', removal_reason = 'Out of uniform' where job_id = $1 and user_id = $2", [removed.id, me.id]);
  await sql("update jobs set state = 'canceled', cancel_reason = 'Weather' where id = $1", [jobGone.id]);
  await sql("update assignments set status = 'canceled', removal_reason = 'Detail canceled' where job_id = $1 and user_id = $2", [jobGone.id, me.id]);

  const page = await session(me, { viewport: DESKTOP });
  await page.goto("/home");
  const upNext = page.getByRole("list", { name: "Up next" });
  await expect(upNext.getByText(working.title)).toBeVisible();
  for (const gone of [dropped, removed, jobGone, backup]) await expect(upNext.getByText(gone.title)).toHaveCount(0);
  await expect(upNext.getByText("Canceled", { exact: true })).toHaveCount(0);
  await expect(upNext.getByText("Removed", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "On backup" })).toBeVisible();
  await expect(page.getByRole("list", { name: "On backup" }).getByText(backup.title)).toBeVisible();

  // The history is still on Details: My details with the Canceled filter.
  await page.goto("/jobs?mine=1&status=canceled");
  for (const gone of [dropped, removed, jobGone]) await expect(page.getByRole("main").getByText(gone.title).first()).toBeVisible();
  await expect(page.getByRole("main").getByText("Out of uniform")).toBeVisible();
});
