import { laterLocalInput } from "../clock";
import { DESKTOP, PHONE, agencyAt, expect, one, pdf, pdfText, type Person, test } from "../fixtures";

/**
 * Coordinator choices on a held invoice: "Approve, don't send" and later "Send now"; a paid-on-the-spot invoice
 * approved and sent as a paid invoice; and a resend to an extra address, which never gets the W-9.
 */
test("approve without sending then Send now, a paid invoice sent as paid, and a resend whose extra address gets no W-9", async ({ agency, session, mail, clock }) => {
  const title = `Food truck rally ${agency.tag}`;
  const job = await agency.detail({ title, startAt: agencyAt(1, 11), count: 2 });
  const kai = await agency.addDeputy(`Kai Benton ${agency.tag}`);
  await agency.signUp(job, agency.deputy);
  await agency.signUp(job, kai);
  await clock.advanceTo(job.id, "end", 60);
  const extra = `owner.${agency.tag.toLowerCase()}@vendor.example`;

  const drew = await session(agency.deputy, { viewport: PHONE });
  const paidDeputy = await session(kai, { viewport: PHONE });
  const coordinator = await session(agency.coordinator, { viewport: DESKTOP });
  const vendor = await session(agency.vendorLogin, { viewport: DESKTOP });
  const invoiceOf = async (p: Person) =>
    (await one<{ id: string }>("select i.id from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1 and a.user_id = $2", [job.id, p.id])).id;

  await test.step("both deputies bill with changed hours; Drew attaches the W-9, Kai was paid by check at the detail", async () => {
    await drew.goto("/profile");
    await drew.getByLabel("Upload your W-9").setInputFiles(pdf("W-9 Drew Fowler"));
    await drew.getByRole("button", { name: "Upload W-9" }).click();
    await expect(drew.getByRole("status").filter({ hasText: "W-9 uploaded." })).toBeVisible();
    for (const [page, paid] of [[drew, false], [paidDeputy, true]] as const) {
      await page.goto("/billing");
      await page.getByRole("article", { name: `${agency.vendor.name}, ${title}` }).getByRole("link", { name: "Review and send invoice" }).click();
      const end = page.getByLabel("End", { exact: true });
      await end.fill(laterLocalInput(await end.inputValue(), 15));
      await page.getByRole("button", { name: "Vendor asked me to stay" }).click();
      if (paid) {
        await page.getByLabel("Paid at the detail").check();
        await page.getByLabel("Method").selectOption({ label: "Check handed to deputy" });
        await page.getByLabel("Check or reference number").fill("5512");
      } else {
        await page.getByLabel("Attach my W-9").check();
      }
      await page.getByRole("button", { name: "Submit for review" }).click();
      await expect(page.getByRole("status").filter({ hasText: "Invoice sent to a coordinator for review." })).toBeVisible();
    }
  });
  const drewInvoice = await invoiceOf(agency.deputy);
  const kaiInvoice = await invoiceOf(kai);

  await test.step("Approve, don't send: the vendor does not see it and the deputy sees it approved and not sent", async () => {
    await coordinator.goto(`/invoices/${drewInvoice}`);
    await coordinator.getByRole("button", { name: "Approve, don't send" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Invoice approved, not sent." })).toBeVisible();
    await clock.deliver();
    expect(mail.find({ to: agency.vendor.billingEmail })).toHaveLength(0);
    await vendor.goto("/vendor/invoices");
    await expect(vendor.getByRole("heading", { level: 1 })).toBeVisible();
    await expect(vendor.getByRole("article").filter({ hasText: agency.deputy.name })).toHaveCount(0);
    await drew.goto("/billing?tab=waiting");
    await expect(drew.getByRole("article").filter({ hasText: title })).toContainText("Approved, not sent to the vendor.");
  });

  await test.step("later, Send now: the vendor gets it with the W-9", async () => {
    await coordinator.goto(`/invoices/${drewInvoice}`);
    await coordinator.getByRole("button", { name: "Send now" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Invoice sent to the vendor." })).toBeVisible();
    const since = mail.mark();
    await clock.deliver();
    const sent = await mail.waitFor({ to: agency.vendor.billingEmail, since });
    expect(sent.attachments).toContain(`W-9 ${agency.deputy.name}.pdf`);
    await vendor.reload();
    await expect(vendor.getByRole("article").filter({ hasText: agency.deputy.name })).toBeVisible();
  });

  await test.step("Kai's paid-on-the-spot invoice is approved and sent as a paid invoice", async () => {
    await coordinator.goto(`/invoices/${kaiInvoice}`);
    await coordinator.getByRole("button", { name: "Approve and send" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: "Invoice was paid on the spot: closed as paid and sent to the vendor marked paid." })).toBeVisible();
    const since = mail.mark();
    await clock.deliver();
    const sent = await mail.waitFor({ to: agency.vendor.billingEmail, since });
    const file = sent.files.find((f) => !f.filename.startsWith("W-9"));
    expect(await pdfText(file!.content)).toContain("PAID");
    expect((await one<{ status: string }>("select status from invoices where id = $1", [kaiInvoice])).status).toBe("paid");
  });

  await test.step("a resend to an extra address: the vendor's billing email gets the W-9, the extra address does not", async () => {
    await coordinator.goto(`/invoices/${drewInvoice}`);
    await coordinator.getByRole("button", { name: "Resend invoice" }).click();
    await coordinator.getByLabel("Also send to").fill(extra);
    await expect(coordinator.getByTestId("resend-recipients")).toContainText("The W-9 goes only to the vendor's billing emails.");
    await coordinator.getByRole("button", { name: "Resend invoice" }).click();
    await expect(coordinator.getByRole("status").filter({ hasText: `Invoice resent to ${agency.vendor.billingEmail}, ${extra}.` })).toBeVisible();
    const since = mail.mark();
    await clock.deliver();
    const toVendor = await mail.waitFor({ to: agency.vendor.billingEmail, since });
    const toExtra = await mail.waitFor({ to: extra, since });
    expect(toVendor.attachments).toContain(`W-9 ${agency.deputy.name}.pdf`);
    expect(toExtra.attachments.some((a) => a.startsWith("W-9"))).toBe(false);
    expect(toExtra.attachments).toHaveLength(1);
  });
});
