import { laterLocalInput } from "../clock";
import { DESKTOP, PHONE, agencyAt, expect, one, pdfText, sql, test } from "../fixtures";

/**
 * Invoice batching: the vendor is sent invoices weekly. One deputy's invoice is approved and queued; another deputy
 * was paid at the detail, so after review that invoice is closed as paid and rides along. The coordinator sends the
 * batch in one email with a cover sheet, where the paid invoice reads Paid and adds $0.00 to the total due. A W-9 goes
 * only with the invoice whose deputy ticked "Attach my W-9", which starts unticked; the batch's "Attach W-9s for every deputy"
 * is off.
 */
test("weekly batch: approved and queued, sent together with a cover sheet; a paid invoice adds nothing", async ({ agency, session, mail, clock }) => {
  const title = `Beach cleanup lot ${agency.tag}`;
  await sql("update vendors set invoice_send_schedule = 'weekly' where id = $1", [agency.vendor.id]);
  const job = await agency.detail({ title, startAt: agencyAt(1, 7), count: 2 });
  const kai = await agency.addDeputy(`Kai Benton ${agency.tag}`);
  await agency.signUp(job, agency.deputy);
  await agency.signUp(job, kai);
  await clock.advanceTo(job.id, "end", 60);

  const drew = await session(agency.deputy, { viewport: PHONE });
  const paidDeputy = await session(kai, { viewport: PHONE });
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });
  const bill = async (page: typeof drew) => {
    await page.goto("/billing");
    await page.getByRole("article", { name: `${agency.vendor.name}, ${title}` }).getByRole("link", { name: "Review and send invoice" }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Bill this detail" })).toBeVisible();
  };

  await test.step("Kai was paid in cash at the detail and stayed 30 minutes, without the W-9; the invoice goes to review", async () => {
    await bill(paidDeputy);
    await expect(paidDeputy.getByLabel("Attach my W-9"), "a W-9 on file is not attached by default").not.toBeChecked();
    const end = paidDeputy.getByLabel("End", { exact: true });
    await end.fill(laterLocalInput(await end.inputValue(), 30));
    await paidDeputy.getByRole("button", { name: "Vendor asked me to stay" }).click();
    await paidDeputy.getByLabel("Paid at the detail").check();
    await paidDeputy.getByLabel("Method").selectOption({ label: "Cash" });
    await paidDeputy.getByRole("button", { name: "Submit for review" }).click();
    await expect(paidDeputy.getByRole("status").filter({ hasText: "Invoice sent to a coordinator for review." })).toBeVisible();
  });

  await test.step("the coordinator approves it: closed as paid, queued for the vendor's next send", async () => {
    await coordinator.goto("/coordinate");
    const row = coordinator.getByRole("region", { name: "Invoices to review" }).getByRole("listitem").filter({ hasText: title });
    await row.getByRole("button", { name: "Approve for the next send" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Invoice was paid on the spot: closed as paid. The paid invoice goes out with the vendor's next invoice send." })).toBeVisible();
  });

  await test.step("Drew bills as scheduled with the W-9; needing no review, the invoice is approved and queued for the weekly send", async () => {
    await bill(drew);
    await expect(drew.getByLabel("Attach my W-9")).not.toBeChecked();
    await drew.getByLabel("Attach my W-9").check();
    await drew.getByRole("button", { name: "Send invoice" }).click();
    await expect(drew.getByRole("status").filter({ hasText: "Invoice approved. It goes out with the vendor's next invoice send." })).toBeVisible();
    await drew.goto("/billing?tab=waiting");
    await expect(drew.getByRole("article").filter({ hasText: title })).toContainText(/Queued for the weekly send on /);
  });

  await test.step("the coordinator sends the batch: the paid invoice reads Paid and adds nothing to the total", async () => {
    await coordinator.goto("/coordinate/send-invoices");
    const card = coordinator.getByRole("region", { name: agency.vendor.name });
    await expect(card.getByRole("listitem").filter({ hasText: kai.name })).toContainText("Paid, nothing due");
    await expect(card.getByRole("listitem").filter({ hasText: agency.deputy.name })).toContainText("$260");
    await expect(card).toContainText("$260");
    const reason = card.getByLabel("Reason for sending early");
    if (await reason.isVisible()) await reason.fill("Vendor asked for this week's invoices today");
    await card.getByRole("button", { name: new RegExp(`^Send (early )?2 invoices to ${agency.vendor.name}$`) }).click();
    const confirm = card.getByRole("group", { name: /^Email 2 invoices/ });
    await expect(confirm).toContainText(`Email 2 invoices totaling $260 to ${agency.vendor.name}`);
    await confirm.getByRole("button", { name: "Send now" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "2 invoices sent in one email." })).toBeVisible();
  });

  await test.step("the vendor gets one email: a cover sheet, both invoices and only Drew's W-9", async () => {
    const since = mail.mark();
    await clock.deliver();
    const sent = mail.find({ to: agency.vendor.billingEmail, since });
    expect(sent).toHaveLength(1);
    expect(sent[0].attachments).toHaveLength(4);
    expect(sent[0].attachments.filter((a) => a.startsWith("W-9"))).toEqual([`W-9 ${agency.deputy.name}.pdf`]);
    const cover = sent[0].files.find((f) => f.filename.startsWith("Invoice summary "));
    expect(cover, "the cover sheet").toBeTruthy();
    const text = await pdfText(cover!.content);
    expect(text).toContain("Paid $292.50");
    expect(text).toMatch(/Total due\s*\$260\.00/);
    const statuses = await sql<{ status: string }>("select i.status from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1 order by i.total_cents", [job.id]);
    expect(statuses.map((s) => s.status)).toEqual(["sent", "paid"]);
    expect((await one<{ n: string }>("select count(distinct batch_id) as n from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1", [job.id])).n).toBe("1");
  });
});
