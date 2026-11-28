import { DESKTOP, PHONE, expect, sql, test } from "../fixtures";

/**
 * Owner request 2026-11-27: the audit log's filters, selection, CSV export and the printed Audit Record with its
 * integrity code, checked afterwards on the verification page. Each export is itself audited.
 */
test("audit log: filter by person, select all matching, export CSV, print a record and verify it", async ({ agency, session }) => {
  const jordan = await agency.addDeputy(`Jordan Pike ${agency.tag}`);
  // Two entries about Jordan, written as the app writes them.
  await sql(
    `insert into audit_log (id, actor_user_id, action, entity_type, entity_id, before, after, reason, at)
     values (gen_random_uuid()::text, $1, 'user.suspend', 'user', $2, '{"suspendedUntil":null}', '{"suspendedUntil":"2035-07-01"}', $3, now() - interval '1 hour'),
            (gen_random_uuid()::text, $1, 'user.contact_update', 'user', $2, '{"phone":"555-0100"}', '{"phone":"555-0101","passwordHash":"never-print-me"}', null, now() - interval '2 hours')`,
    [agency.coordinator.id, jordan.id, `Missed two details ${agency.tag}`],
  );
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });

  await test.step("filter by About and text: only Jordan's entries", async () => {
    await coordinator.goto(`/admin/audit?about=${jordan.id}`);
    await expect(coordinator.getByTestId("audit-entry")).toHaveCount(2);
    await coordinator.getByLabel("Search").first().fill(`Missed two details ${agency.tag}`);
    await coordinator.getByRole("button", { name: "Apply" }).click();
    await expect(coordinator).toHaveURL(/q=Missed/);
    await expect(coordinator.getByTestId("audit-entry")).toHaveCount(1);
    await coordinator.goto(`/admin/audit?about=${jordan.id}`);
  });

  await test.step("select all matching and export the CSV", async () => {
    await coordinator.getByRole("button", { name: "Select all 2 matching" }).click();
    await expect(coordinator.getByTestId("audit-selected")).toHaveText("All 2 matching entries selected.");
    const [download] = await Promise.all([coordinator.waitForEvent("download"), coordinator.getByRole("button", { name: "Export CSV" }).click()]);
    const csv = await download.createReadStream().then(async (s) => {
      const chunks: Buffer[] = [];
      for await (const c of s) chunks.push(c as Buffer);
      return Buffer.concat(chunks).toString("utf8");
    });
    expect(csv.split("\r\n")[0]).toContain("Entry ID,Time,Done by");
    expect(csv).toContain(`Missed two details ${agency.tag}`);
    expect(csv).not.toContain("never-print-me");
    const [audit] = await sql<{ after: { entries: number } }>("select after from audit_log where action = 'audit.export' and actor_user_id = $1 order by at desc limit 1", [agency.coordinator.id]);
    expect(audit.after.entries).toBe(2);
  });

  let recordId = "";
  await test.step("print the Audit Record", async () => {
    const [download] = await Promise.all([coordinator.waitForEvent("download"), coordinator.getByRole("button", { name: "Print PDF" }).click()]);
    recordId = /Audit Record - (AR-\d{6})\.pdf/.exec(download.suggestedFilename())?.[1] ?? "";
    expect(recordId).toMatch(/^AR-\d{6}$/);
    const [audit] = await sql<{ after: { record: string; entries: number } }>("select after from audit_log where action = 'audit.print' and actor_user_id = $1 order by at desc limit 1", [agency.coordinator.id]);
    expect(audit.after).toMatchObject({ record: recordId, entries: 2 });
  });

  await test.step("an admin verifies it, then sees a mismatch after the data changes", async () => {
    const admin = await session(agency.admin, { viewport: DESKTOP });
    await admin.goto("/admin/audit/verify");
    await admin.getByLabel("Record ID").fill(recordId);
    await admin.getByRole("button", { name: "Check the record" }).click();
    await expect(admin.getByTestId("verify-result")).toContainText(`${recordId} matches the audit log.`);
    await sql("update audit_log set reason = 'changed' where action = 'user.suspend' and entity_id = $1", [jordan.id]);
    await admin.getByRole("button", { name: "Check the record" }).click();
    await expect(admin.getByTestId("verify-result")).toContainText(`${recordId} does not match the audit log.`);
  });

  await test.step("at 390 px the filters open from the Filters button and the page does not scroll sideways", async () => {
    const phone = await session(agency.coordinator, { viewport: PHONE });
    await phone.goto(`/admin/audit?about=${jordan.id}`);
    await phone.getByRole("button", { name: /^Filters/ }).click();
    await expect(phone.getByRole("button", { name: "Apply" })).toBeVisible();
    const wide = await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(wide).toBe(false);
  });
});
