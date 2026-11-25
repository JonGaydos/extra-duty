import { DESKTOP, agencyAt, agencyDay, expect, sql, test } from "../fixtures";

/**
 * The personnel activity report: filtered by rank (and by a flag only this run's people hold, so other runs' rows stay
 * out), the leaderboards rank the people who worked most, and the CSV carries the same rows.
 */
test("personnel activity report: rank filter, leaderboards and CSV", async ({ agency, session }) => {
  const flag = `Flow team ${agency.tag}`;
  const [{ id: flagId }] = await sql<{ id: string }>("insert into qualifications (id, name) values (gen_random_uuid()::text, $1) returning id", [flag]);
  const lane = await agency.addDeputy(`Lane Ortega ${agency.tag}`, { rank: "CSO" });
  const max = await agency.addDeputy(`Max Wilder ${agency.tag}`, { rank: "CSO" });
  const ray = await agency.addDeputy(`Ray Dunn ${agency.tag}`);
  for (const p of [lane, max, ray]) await sql("insert into user_qualifications (id, user_id, qualification_id) values (gen_random_uuid()::text, $1, $2)", [p.id, flagId]);

  /** A worked, billed detail `days` ago for `hours`. */
  const worked = async (who: typeof lane, days: number, hours: number) => {
    const d = await agency.detail({ title: `Gate shift ${agency.tag} ${who.name.split(" ")[0]} ${days}`, startAt: agencyAt(-days, 8), hours, position: "CSO" });
    const id = await agency.signUp(d, who);
    await sql("update assignments set status = 'billed', billed_at = now() where id = $1", [id]);
  };
  await worked(lane, 3, 4);
  await worked(lane, 2, 6);
  await worked(max, 2, 4);
  await worked(ray, 3, 8);
  await worked(ray, 2, 8);

  const page = await session(agency.coordinator, { viewport: DESKTOP });
  await page.goto("/coordinate/reports/activity");
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  await page.getByText("Custom", { exact: true }).click();
  await page.getByLabel("From", { exact: true }).fill(agencyDay(agencyAt(-7, 12)));
  await page.getByLabel("To", { exact: true }).fill(agencyDay(agencyAt(0, 12)));
  await page.getByLabel("Rank").selectOption({ label: "CSO" });
  await page.getByLabel("Flag").selectOption({ label: flag });
  await page.getByRole("button", { name: "Run report" }).click();

  await test.step("the table lists only the CSOs, with their hours", async () => {
    const table = page.getByRole("table");
    await expect(table.getByRole("caption")).toHaveText("Everyone, 2 people");
    await expect(table.getByRole("row", { name: new RegExp(lane.name) })).toContainText("10");
    await expect(table.getByRole("row", { name: new RegExp(max.name) })).toContainText("4");
    await expect(table).not.toContainText(ray.name);
  });

  await test.step("the leaderboards rank them", async () => {
    for (const board of ["board-hours", "board-details_worked"]) {
      const items = page.locator(`[aria-labelledby="${board}"]`).getByRole("listitem");
      await expect(items).toHaveCount(2);
      await expect(items.nth(0)).toContainText(lane.name);
      await expect(items.nth(1)).toContainText(max.name);
    }
  });

  await test.step("the CSV carries the same rows", async () => {
    const download = page.waitForEvent("download");
    await page.getByRole("button", { name: "Download CSV" }).click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(/^Personnel activity \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\.csv$/);
    const chunks: Buffer[] = [];
    for await (const c of (await file.createReadStream())!) chunks.push(c as Buffer);
    const csv = Buffer.concat(chunks).toString("utf8");
    const lines = csv.trim().split(/\r?\n/);
    expect(lines).toHaveLength(3);
    expect(csv).toContain(lane.name);
    expect(csv).toContain(max.name);
    expect(csv).not.toContain(ray.name);
  });
});
