import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { agencyDateParts } from "@/domain/time/agency-time";
import { COORD } from "./coordinator-fixtures";
import { E2E } from "./env";
import { signInAs } from "./session";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const THEMES = [
  { name: "day", colorScheme: "light" },
  { name: "night", colorScheme: "dark" },
] as const;

async function expectNoSeriousA11yIssues(page: Page) {
  const { violations } = await new AxeBuilder({ page }).analyze();
  const serious = violations.filter((v) => v.impact === "serious" || v.impact === "critical");
  expect(serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(" ")).join(", ")}`)).toEqual([]);
}

async function rows<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    return (await client.query(sql, params)).rows as T[];
  } finally {
    await client.end();
  }
}
const one = async <T,>(sql: string, params: unknown[] = []) => (await rows<T>(sql, params))[0];

const jobId = async (title: string) => (await one<{ id: string }>("select id from jobs where title = $1 order by start_at limit 1", [title])).id;
const invoiceId = async (title: string) =>
  (await one<{ id: string }>("select i.id from invoices i join assignments a on a.id = i.assignment_id join jobs j on j.id = a.job_id where j.title = $1", [title])).id;
const vendorId = async (name: string) => (await one<{ id: string }>("select id from vendors where name = $1", [name])).id;
const userId = async (email: string) => (await one<{ id: string }>("select id from users where email = $1", [email])).id;

/** The coming December: details made by these tests never land in the past. */
function december(): number {
  const p = agencyDateParts(new Date());
  return p.month === 12 ? p.year + 1 : p.year;
}

type Screen = { name: string; path: () => Promise<string>; heading: string | RegExp };

// Every path is a promise, since some screens look up a record id first; `at` gives a fixed path in that shape.
const at = (path: string) => () => Promise.resolve(path);
const SCREENS: Screen[] = [
  { name: "todo", path: at("/coordinate"), heading: /^Good (morning|afternoon|evening), Quinn/ },
  { name: "details", path: at("/coordinate/details"), heading: "Details" },
  { name: "new-detail", path: at("/coordinate/details/new"), heading: "New detail" },
  { name: "detail", path: async () => `/coordinate/details/${await jobId(COORD.opsJob)}`, heading: COORD.opsJob },
  { name: "request", path: async () => `/coordinate/details/${await jobId(COORD.request)}`, heading: COORD.request },
  { name: "vendors", path: at("/coordinate/vendors"), heading: "Vendors" },
  { name: "vendor", path: async () => `/coordinate/vendors/${await vendorId(COORD.vendor)}`, heading: COORD.vendor },
  { name: "payments", path: async () => `/coordinate/payments?open=${await invoiceId(COORD.issueJob)}`, heading: "Payments" },
  { name: "invoice", path: async () => `/invoices/${await invoiceId(COORD.issueJob)}`, heading: /^Invoice / },
  { name: "send-invoices", path: at("/coordinate/send-invoices"), heading: "Send invoices" },
  { name: "ops-plans", path: at("/coordinate/ops-plans"), heading: "Ops plans" },
  { name: "reports", path: at("/coordinate/reports"), heading: "Reports" },
  { name: "deputy-earnings", path: async () => `/coordinate/reports/deputies/${await userId(COORD.signed.email)}`, heading: `Earnings: ${COORD.signed.name}` },
];

for (const theme of THEMES) {
  test.describe(`coordinator screens, ${theme.name}`, () => {
    test.use({ colorScheme: theme.colorScheme });

    for (const screen of SCREENS) {
      test(`${screen.name} at phone and desktop sizes`, async ({ page, context }) => {
        await signInAs(context, "coordinator");
        const path = await screen.path();
        for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
          await page.setViewportSize(viewport);
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1, name: screen.heading })).toBeVisible();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, "no sideways page scroll").toBeLessThanOrEqual(0);
          await page.screenshot({ path: `${E2E.screenshotDir}/coordinator-${screen.name}-${size}-${theme.name}.png`, fullPage: true });
          await expectNoSeriousA11yIssues(page);
        }
      });
    }
  });
}

test("the to-do list shows every section in order, with the alerts bell on phones", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/coordinate");
  await expect(page.getByRole("link", { name: /^Alerts/ })).toBeVisible();
  const headings = await page.getByRole("main").getByRole("heading", { level: 2 }).allInnerTexts();
  const order = [
    "Locked detail started: cancel",
    "Vendor requests",
    "Deputy notes to review",
    "Flag requests",
    "Details missing a contract",
    "Invoices to review",
    "Send invoices",
    "Payment issues with you",
    "Ops plans",
    "Unfilled, starting within 72 hours",
    "Sign-up locks",
  ];
  const found = order.map((h) => headings.findIndex((t) => t.startsWith(h)));
  expect(found.every((i) => i >= 0), `sections present: ${headings.join(" | ")}`).toBe(true);
  expect([...found].sort((a, b) => a - b)).toEqual(found);
  await expect(page.getByRole("main")).toContainText(COORD.note);
  await expect(page.getByRole("main")).toContainText("Day 10 of 7");
});

test("a coordinator creates a detail on 6 picked dates in one save, as one series", async ({ page, context }) => {
  const title = "Holiday lot patrol, picked dates";
  const year = december();
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/coordinate/details/new");
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: COORD.vendor });
  await page.getByLabel("Location", { exact: true }).selectOption({ label: `${COORD.location}, ${COORD.address}` });
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Start time").fill("07:00");
  await page.getByLabel("End time").fill("15:00");
  await page.getByRole("tab", { name: "Pick dates" }).click();
  const month = page.getByRole("heading", { name: `December ${year}` });
  for (let i = 0; i < 14 && !(await month.isVisible()); i++) await page.getByRole("button", { name: "Next month" }).click();
  await expect(month).toBeVisible();
  for (const d of [1, 12, 19, 20, 21, 30]) await page.getByRole("button", { name: new RegExp(`, Dec ${d}$`) }).click();
  await expect(page.getByText("6 details will be created")).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  await page.getByRole("button", { name: "Create 6 details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "6 details created in one series." })).toBeVisible();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  const made = await rows<{ series_id: string; day: string }>(
    "select series_id, to_char(start_at at time zone 'America/Chicago', 'YYYY-MM-DD') as day from jobs where title = $1 order by start_at",
    [title],
  );
  expect(made.map((r) => r.day)).toEqual([1, 12, 19, 20, 21, 30].map((d) => `${year}-12-${String(d).padStart(2, "0")}`));
  expect(new Set(made.map((r) => r.series_id)).size).toBe(1);
  expect(made[0].series_id).toBeTruthy();
});

test("a coordinator creates a detail for every day of a date range", async ({ page, context }) => {
  const title = "Holiday lot patrol, range";
  const year = december();
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/coordinate/details/new");
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: COORD.vendor });
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Start time").fill("18:00");
  await page.getByLabel("End time").fill("22:00");
  await page.getByRole("tab", { name: "Range" }).click();
  await page.getByLabel("From", { exact: true }).fill(`${year}-12-15`);
  await page.getByLabel("To", { exact: true }).fill(`${year}-12-31`);
  await expect(page.getByText("17 details will be created")).toBeVisible();
  await page.getByRole("button", { name: "Create 17 details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "17 details created in one series." })).toBeVisible();
  const made = await rows<{ series_id: string }>("select series_id from jobs where title = $1", [title]);
  expect(made).toHaveLength(17);
  expect(new Set(made.map((r) => r.series_id)).size).toBe(1);
});

test("a failing date is named beside its row, and nothing is created", async ({ page, context }) => {
  const title = "Per-date error check";
  const year = december();
  const label = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${year}-12-03T12:00:00Z`));
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/coordinate/details/new");
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: COORD.vendor });
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Start time").fill("09:00");
  await page.getByLabel("End time").fill("13:00");
  await page.getByRole("tab", { name: "Pick dates" }).click();
  const month = page.getByRole("heading", { name: `December ${year}` });
  for (let i = 0; i < 14 && !(await month.isVisible()); i++) await page.getByRole("button", { name: "Next month" }).click();
  for (const d of [2, 3]) await page.getByRole("button", { name: new RegExp(`, Dec ${d}$`) }).click();
  await page.getByRole("button", { name: `Change times, ${label}` }).click();
  await page.getByLabel(`Start, ${label}`).fill("08:00");
  await page.getByLabel(`End, ${label}`).fill("08:00");
  await page.getByRole("button", { name: "Create 2 details" }).click();
  const row = page.locator(`#preview-${year}-12-03`);
  await expect(row).toContainText("The end time must differ from the start time.");
  await expect(page.getByRole("status")).toContainText(`${label}: The end time must differ from the start time. Nothing was created.`);
  expect(await rows("select id from jobs where title = $1", [title])).toHaveLength(0);
  await page.getByLabel(`End, ${label}`).fill("12:00");
  await expect(row).not.toContainText("The end time must differ");
});

test("editing the series rate alerts a signed-up deputy", async ({ page, context, browser }) => {
  const title = "Holiday lot patrol, picked dates";
  const first = await one<{ id: string }>("select id from jobs where title = $1 order by start_at limit 1", [title]);
  const position = await one<{ id: string }>("select id from job_positions where job_id = $1", [first.id]);
  const riley = await userId(COORD.signed.email);
  await rows("insert into assignments (id, job_id, job_position_id, user_id, status) values (gen_random_uuid()::text, $1, $2, $3, 'signed_up')", [first.id, position.id, riley]);

  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto(`/coordinate/details/${first.id}`);
  await page.getByRole("button", { name: "Edit detail" }).click();
  const editor = page.getByRole("form", { name: "Edit detail" });
  await editor.getByLabel("Rate per hour").fill("90");
  await editor.getByRole("radio", { name: "This and later details in the series" }).check();
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved 6 details." })).toBeVisible();
  const rates = await rows<{ rate_cents: number }>("select distinct rate_cents from jobs where title = $1", [title]);
  expect(rates).toEqual([{ rate_cents: 9000 }]);

  const deputy = await browser.newContext({ viewport: PHONE });
  await signInAs(deputy, "riley");
  const p = await deputy.newPage();
  await p.goto("/alerts");
  await expect(p.getByRole("main")).toContainText(`Detail changed: ${title}`);
  await expect(p.getByRole("main")).toContainText("The hourly rate changed");
  await deputy.close();
});

test("a coordinator approves a vendor request", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/coordinate");
  await page.getByRole("region", { name: "Vendor requests" }).getByRole("link", { name: `Review request, ${COORD.request}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: COORD.request })).toBeVisible();
  await page.getByRole("button", { name: "Approve request" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Request approved." })).toBeVisible();
  expect((await one<{ state: string }>("select state from jobs where title = $1", [COORD.request])).state).toBe("scheduled");
});

test("a coordinator approves a held invoice from the to-do list", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/coordinate");
  const row = page.getByRole("region", { name: "Invoices to review" }).getByRole("listitem").filter({ hasText: COORD.approveInvoiceJob });
  await expect(row).toContainText("Vendor asked me to stay");
  await row.getByRole("button", { name: "Approve and send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice approved and sent to the vendor." })).toBeVisible();
  expect((await one<{ status: string }>("select status from invoices where id = $1", [await invoiceId(COORD.approveInvoiceJob)])).status).toBe("sent");
});

test("approve, don't send: the vendor's default leads, the vendor cannot see it, the deputy sees it as not sent, then Send now sends it", async ({ page, context, browser }) => {
  const id = await invoiceId(COORD.unsentInvoiceJob);
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/coordinate");
  // The vendor is set to not get approved invoices by email, so that choice comes first on the to-do list.
  const row = page.getByRole("region", { name: "Invoices to review" }).getByRole("listitem").filter({ hasText: COORD.unsentInvoiceJob });
  await expect(row.getByRole("button").first()).toHaveText("Approve, don't send");
  await expect(row.getByRole("button", { name: "Approve and send" })).toBeVisible();

  await page.goto(`/invoices/${id}`);
  await expect(page.getByText(`${COORD.unsentVendor} is set to not get approved invoices by email.`)).toBeVisible();
  await page.screenshot({ path: `${E2E.screenshotDir}/coordinator-approve-choice-desktop.png`, fullPage: true });
  await page.getByRole("button", { name: "Approve, don't send" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice approved, not sent." })).toBeVisible();
  await expect(page.getByText("Approved, not sent", { exact: true })).toBeVisible();
  expect(await one("select status, sent_at, email_status from invoices where id = $1", [id])).toMatchObject({ status: "approved_unsent", sent_at: null, email_status: "not_queued" });
  await page.screenshot({ path: `${E2E.screenshotDir}/coordinator-approved-unsent-desktop.png`, fullPage: true });
  await expectNoSeriousA11yIssues(page);

  // The vendor does not see it; the deputy sees it as approved and not sent.
  const vendor = await browser.newContext({ viewport: DESKTOP });
  await signInAs(vendor, "vendor");
  const v = await vendor.newPage();
  await v.goto("/vendor/invoices");
  await expect(v.getByRole("heading", { level: 1 })).toBeVisible();
  expect(await v.getByRole("main").innerText()).not.toContain(COORD.unsentInvoiceJob);
  const deputy = await browser.newContext({ viewport: PHONE });
  await signInAs(deputy, "riley");
  const d = await deputy.newPage();
  await d.goto("/billing?tab=waiting");
  const card = d.getByRole("article").filter({ hasText: COORD.unsentVendor });
  await expect(card).toContainText("Approved, not sent to the vendor.");
  await expect(card.getByRole("button", { name: /^Mark received/ })).toBeVisible();

  // Payments lists it with Send now; sending makes it the vendor's turn and the vendor sees it.
  await page.goto("/coordinate/payments");
  const unsent = page.getByRole("table", { name: /Approved, not sent/ });
  await expect(unsent).toContainText(COORD.unsentVendor);
  await page.goto(`/invoices/${id}`);
  await page.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice sent to the vendor." })).toBeVisible();
  expect((await one<{ status: string }>("select status from invoices where id = $1", [id])).status).toBe("sent");
  await v.reload();
  await expect(v.getByRole("main")).toContainText(COORD.unsentInvoiceJob);
  await vendor.close();
  await deputy.close();
});

test("a coordinator resends a sent invoice with an extra address, and staff can download the PDF from the lists and the invoice", async ({ page, context }) => {
  const id = await invoiceId(COORD.approveInvoiceJob);
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  // Sent by the to-do test; make sure here so this test stands alone.
  if ((await one<{ status: string }>("select status from invoices where id = $1", [id])).status === "pending_review") {
    await page.goto(`/invoices/${id}`);
    await page.getByRole("button", { name: "Approve and send" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Invoice approved and sent to the vendor." })).toBeVisible();
  }
  await page.goto("/coordinate/payments");
  const pdf = page.getByRole("link", { name: /^PDF for invoice / }).first();
  await expect(pdf).toBeVisible();
  const href = await pdf.getAttribute("href");
  const res = await page.request.get(href!);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("application/pdf");

  await page.goto(`/invoices/${id}`);
  await expect(page.getByRole("link", { name: /^Download PDF/ })).toBeVisible();
  await page.getByRole("button", { name: "Resend invoice" }).click();
  await page.getByLabel("Also send to").fill("owner@schoolboard.example");
  await expect(page.getByTestId("resend-recipients")).toContainText("owner@schoolboard.example");
  await page.screenshot({ path: `${E2E.screenshotDir}/coordinator-resend-confirm-desktop.png`, fullPage: true });
  await expectNoSeriousA11yIssues(page);
  await page.getByRole("button", { name: "Resend invoice" }).click();
  await expect(page.getByRole("status").filter({ hasText: /Invoice resent to .*owner@schoolboard\.example\./ })).toBeVisible();
  const job = await one<{ data: { invoiceId: string; to?: string[] } }>("select data from pgboss.job where name = 'email.invoice' and data->>'invoiceId' = $1 and data ? 'to'", [id]);
  expect(job.data.to).toContain("owner@schoolboard.example");
  expect((await one<{ action: string }>("select action from audit_log where entity_id = $1 and action = 'invoice.resend'", [id])).action).toBe("invoice.resend");
});

test("a coordinator sends a vendor's due batch with W-9s for all, holding nothing and leaving the waiting detail queued", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/coordinate");
  const todo = page.getByRole("region", { name: "Send invoices" });
  await expect(todo).toContainText(`${COORD.batchVendor}, 1 invoice, $420`);
  await expect(todo).toContainText(`Waiting on 1 deputy to bill (${COORD.waitingDeputy})`);
  await todo.getByRole("link", { name: `Review and send, ${COORD.batchVendor}` }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Send invoices" })).toBeVisible();
  const card = page.getByRole("region", { name: COORD.batchVendor });
  await expect(card).toContainText(`${COORD.waitingJob.split(",")[0]}`);
  await expect(card).toContainText(COORD.waitingDeputy);
  await card.getByRole("switch", { name: "Attach W-9s for every deputy in this batch" }).click();
  await expect(card).toContainText(`No W-9 on file: ${COORD.signed.name}`);
  await card.getByRole("radio", { name: "Send their invoices without a W-9" }).check();
  await expectNoSeriousA11yIssues(page);
  await card.getByRole("button", { name: `Send 1 invoice to ${COORD.batchVendor}` }).click();
  const confirm = card.getByRole("group", { name: /^Email 1 invoice/ });
  await expect(confirm).toContainText(`Email 1 invoice totaling $420 to ${COORD.batchVendor}, with no W-9s attached?`);
  await expect(confirm).toContainText("This cannot be undone.");
  await expectNoSeriousA11yIssues(page);
  await confirm.getByRole("button", { name: "Send now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "1 invoice sent in one email." })).toBeVisible();
  expect((await one<{ status: string; sent: boolean }>("select status, sent_at is not null as sent from invoices where id = $1", [await invoiceId(COORD.batchJob)]))).toEqual({ status: "sent", sent: true });
  expect((await one<{ status: string }>("select status from invoices where id = $1", [await invoiceId(COORD.waitingJob)])).status).toBe("ready_to_send");
});

test("a coordinator sends a held invoice back from the invoice page", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  const id = await invoiceId(COORD.sendBackInvoiceJob);
  await page.goto(`/invoices/${id}`);
  await expect(page.getByRole("heading", { level: 1, name: /^Invoice / })).toBeVisible();
  await page.getByRole("button", { name: "Send back" }).click();
  await page.getByLabel("Comment for the deputy").fill("Bill the scheduled end time; the vendor did not ask you to stay.");
  await page.getByRole("button", { name: "Send back invoice" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Invoice sent back to ${COORD.signed.name}.` })).toBeVisible();
  expect((await one<{ status: string }>("select status from invoices where id = $1", [id])).status).toBe("returned");
});

test("a locked detail that started cancels in one tap with the reason filled in", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/coordinate");
  const card = page.getByRole("region", { name: "Locked detail started: cancel" });
  await expect(card).toContainText(COORD.lockedJob);
  await expect(card.getByLabel("Reason")).toHaveValue(/payment hold/);
  await card.getByRole("button", { name: "Cancel detail" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Detail canceled." })).toBeVisible();
  const job = await one<{ state: string }>("select state from jobs where title = $1", [COORD.lockedJob]);
  expect(job.state).toBe("canceled");
  const a = await one<{ status: string }>("select a.status from assignments a join jobs j on j.id = a.job_id where j.title = $1", [COORD.lockedJob]);
  expect(a.status).toBe("late_canceled");
});

test("personnel cannot open coordinator screens", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.goto("/coordinate/payments");
  await expect(page).toHaveURL(/\/home$/);
});

test("a coordinator attaches a contract to a detail that has none, and the detail stops showing No contract", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  const id = await jobId(COORD.unfilledJob);
  await page.goto(`/coordinate/details/${id}`);
  await expect(page.getByText("No contract", { exact: true })).toBeVisible();
  const form = page.getByRole("form", { name: "Attach contract" });
  await expect(form).toBeVisible();
  await form.getByLabel("Label").fill("Gym doors agreement");
  await form.getByLabel("Contract file").setInputFiles({ name: "agreement.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n") });
  await form.getByRole("button", { name: "Attach contract" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Contract attached." })).toBeVisible();
  await expect(page.getByText("No contract", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("link", { name: /Gym doors agreement/ })).toBeVisible();
  const att = await one<{ label: string; is_contract: boolean }>("select label, is_contract from job_attachments where job_id = $1", [id]);
  expect(att).toEqual({ label: "Gym doors agreement", is_contract: true });
  // With a contract on the detail, the form folds away; it stays available to attach a replacement.
  await expect(page.getByRole("form", { name: "Attach contract" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Attach a different contract" })).toBeVisible();
  await expectNoSeriousA11yIssues(page);
});

test("a coordinator cancels a detail with two deputies, then reactivates it with a reason; their late-cancel pay is canceled, a deputy signs up again and the vendor sees it scheduled", async ({ page, context, browser }) => {
  const cancelWhy = "Vendor postponed homecoming";
  const backWhy = "Vendor confirmed it is going ahead";
  const [taylor, sam] = COORD.backOnDeputies;
  const id = await jobId(COORD.backOnJob);
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto(`/coordinate/details/${id}`);
  await page.getByRole("button", { name: "Cancel detail" }).click();
  await page.getByLabel("Reason", { exact: true }).fill(cancelWhy);
  // For the vendor, inside the window: both deputies are owed late-cancel pay.
  await page.getByLabel(/^The vendor canceled/).check();
  await page.getByRole("button", { name: "Cancel detail" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Detail canceled." })).toBeVisible();

  // Late-cancel pay cannot be billed before the detail's scheduled end: the deputy's bill button waits.
  const early = await browser.newContext({ viewport: PHONE });
  await signInAs(early, "backOn");
  const b = await early.newPage();
  await b.goto("/billing?tab=bill");
  const lateCard = b.getByRole("article", { name: new RegExp(COORD.backOnJob) });
  await expect(lateCard).toContainText(/You can bill late-cancel pay after [A-Z][a-z]{2} \d{1,2}, \d{4} at \d{1,2}:\d{2} [AP]M\./);
  await expect(lateCard.getByRole("button", { name: "Review and send invoice" })).toBeDisabled();
  await b.screenshot({ path: `${E2E.screenshotDir}/personnel-late-cancel-bill-later-phone.png`, fullPage: true });
  await expectNoSeriousA11yIssues(b);
  await early.close();

  await page.getByRole("button", { name: "Reactivate detail" }).click();
  const confirm = page.getByRole("region", { name: "Reactivate this detail" });
  await expect(confirm.getByTestId("reactivate-notify")).toContainText(`${sam.name} and ${taylor.name}`);
  await expect(confirm.getByTestId("reactivate-late-cancel")).toContainText(`${sam.name} and ${taylor.name}. The vendor is going ahead, so no late cancel happened.`);
  await expect(confirm.getByText(/waive/i)).toHaveCount(0);
  await confirm.getByLabel("Reason", { exact: true }).fill(backWhy);
  await page.screenshot({ path: `${E2E.screenshotDir}/coordinator-reactivate-confirm-desktop.png`, fullPage: true });
  await expectNoSeriousA11yIssues(page);
  await page.setViewportSize(PHONE);
  // The cancel's status note floats over the bottom of the screen; dismiss it to see the confirm step's actions.
  await page.getByRole("button", { name: "Dismiss" }).click();
  await confirm.scrollIntoViewIfNeeded();
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no sideways page scroll").toBeLessThanOrEqual(0);
  await confirm.screenshot({ path: `${E2E.screenshotDir}/coordinator-reactivate-confirm-phone.png` });
  await confirm.getByRole("button", { name: "Reactivate", exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${E2E.screenshotDir}/coordinator-reactivate-confirm-phone-actions.png` });
  await page.setViewportSize(DESKTOP);
  await confirm.getByRole("button", { name: "Reactivate", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Detail reactivated." })).toBeVisible();
  expect((await one<{ state: string }>("select state from jobs where id = $1", [id])).state).toBe("scheduled");

  // The history keeps the cancel and the reactivation, in order, and the old sign-ups stay as Canceled.
  const history = page.getByRole("list", { name: "Sign-up history" });
  const events = history.getByTestId("detail-event");
  await expect(events).toHaveCount(2);
  await expect(events.nth(0)).toContainText(new RegExp(`Canceled by Quinn Okafor on .+: ${cancelWhy}`));
  await expect(events.nth(1)).toContainText(new RegExp(`Reactivated by Quinn Okafor on .+: ${backWhy}`));
  for (const d of [taylor, sam]) await expect(history.getByRole("listitem").filter({ hasText: d.name })).toContainText("Late-cancel pay canceled");
  const activity = page.getByRole("main").getByRole("listitem").filter({ hasText: /^Reactivated by Quinn Okafor/ });
  await expect(activity.first()).toBeVisible();
  await expect(page.getByRole("button", { name: "Reactivate detail" })).toHaveCount(0);
  await page.screenshot({ path: `${E2E.screenshotDir}/coordinator-reactivated-desktop.png`, fullPage: true });

  // A deputy who was on it sees it open, with no reasons, and signs up again.
  const deputy = await browser.newContext({ viewport: PHONE });
  await signInAs(deputy, "backOn");
  const d = await deputy.newPage();
  await d.goto("/alerts");
  await expect(d.getByRole("main")).toContainText("is back on. Sign up again if you still want it.");
  await d.goto(`/jobs/${id}`);
  await expect(d.getByRole("heading", { level: 1, name: COORD.backOnJob })).toBeVisible();
  for (const why of [cancelWhy, backWhy]) await expect(d.locator("body")).not.toContainText(why);
  // Their late-cancel pay went with the reactivation: they sign up like anyone else, with no pay warning.
  await d.getByRole("button", { name: "Sign up for Deputy Sheriff" }).click();
  const dialog = d.getByRole("dialog", { name: "Before you sign up" });
  await expect(dialog).not.toContainText("late-cancel");
  await d.screenshot({ path: `${E2E.screenshotDir}/personnel-signup-again-phone.png` });
  await expectNoSeriousA11yIssues(d);
  await dialog.getByRole("button", { name: "Accept and sign up" }).click();
  await expect(d.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();
  await deputy.close();
  const owed = await rows<{ email: string; status: string; removal_reason: string | null }>(
    "select u.email, a.status, a.removal_reason from assignments a join users u on u.id = a.user_id where a.job_id = $1 order by a.created_at",
    [id],
  );
  expect(owed).toEqual([
    { email: taylor.email, status: "canceled", removal_reason: "detail reactivated" },
    { email: sam.email, status: "canceled", removal_reason: "detail reactivated" },
    { email: taylor.email, status: "signed_up", removal_reason: null },
  ]);

  // The vendor sees it scheduled again, with no reasons.
  const vendor = await browser.newContext({ viewport: DESKTOP });
  await signInAs(vendor, "vendor");
  const v = await vendor.newPage();
  await v.goto(`/vendor/details/${id}`);
  await expect(v.getByRole("heading", { level: 1, name: COORD.backOnJob })).toBeVisible();
  await expect(v.getByRole("main")).toContainText("Scheduled");
  for (const why of [cancelWhy, backWhy]) await expect(v.locator("body")).not.toContainText(why);
  await expect(v.getByRole("main")).not.toContainText("Canceled");
  await vendor.close();
});

test("Payments filters live in the address: status, days waiting, vendor search, amount and sent, and Back keeps them", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/coordinate/payments");
  const panel = page.getByRole("complementary", { name: "Filters" });
  const captions = () => page.getByRole("main").locator("table caption").allTextContents();

  await panel.getByLabel("Coordinator's turn").check();
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/[?&]status=coordinator/);
  for (const c of await captions()) expect(c).toMatch(/^Coordinator's turn/);

  await page.goBack();
  await expect(page).not.toHaveURL(/status=/);
  await expect(page.getByRole("main").locator("table caption").filter({ hasText: /^Vendor's turn/ })).toBeVisible();

  // A shared link: over 30 days waiting, sent only, at least $1.
  await page.goto("/coordinate/payments?days=31-&sent=sent&amin=1");
  await expect(panel.getByLabel("Days waiting on this step")).toHaveValue("31-");
  for (const cell of await page.getByRole("main").getByRole("cell", { name: /of \d+ days/ }).allTextContents()) {
    const waited = cell.split(" of ")[0].replace(/\D/g, "");
    expect(Number(waited)).toBeGreaterThan(30);
  }
  await expect(page.getByRole("table", { name: /Approved, not sent/ })).toHaveCount(0);

  // The vendor list narrows as you type; a checked vendor filters the lists.
  await page.goto("/coordinate/payments");
  await panel.locator("summary").filter({ hasText: /^Vendor/ }).click();
  await panel.getByLabel("Search vendor").fill(COORD.unsentVendor.slice(0, 6));
  await expect(panel.getByLabel(COORD.unsentVendor)).toBeVisible();
  await panel.getByLabel(COORD.unsentVendor).check();
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/[?&]vendor=/);
  await expect(page.getByRole("main").locator("tbody tr").first()).toBeVisible();
  for (const row of await page.getByRole("main").locator("tbody tr").allTextContents()) expect(row).toContain(COORD.unsentVendor);

  // Phone: the panel opens from the Filters button and the page never scrolls sideways.
  await page.setViewportSize(PHONE);
  await page.goto("/coordinate/payments?status=vendor");
  const button = page.getByRole("button", { name: /^Filters \(1 on\)$/ });
  await expect(button).toBeVisible();
  await button.click();
  await expect(panel.getByLabel("Vendor's turn")).toBeChecked();
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(PHONE.width);
  await expectNoSeriousA11yIssues(page);
});

test("staff see how and when an invoice goes to the vendor, and where approving sends it", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  const sent = await one<{ id: string }>("select id from invoices where status = 'sent' order by number limit 1");
  await page.goto(`/invoices/${sent.id}`);
  await expect(page.getByTestId("send-line")).toHaveText(/^Sent (right away when billed|when approved on|with the|in a batch)/);
  const held = await one<{ id: string } | undefined>("select id from invoices where status = 'pending_review' order by number limit 1");
  if (held) {
    await page.goto(`/invoices/${held.id}`);
    await expect(page.getByTestId("send-line")).toHaveText(/^Waiting for review/);
    await expect(page.getByTestId("approve-line")).toHaveText(/^Approve (and send: goes to .+ now|for the next send: the .+ send on .+)\.$/);
  }
  const vendor = await vendorId(COORD.batchVendor);
  await page.goto(`/coordinate/vendors/${vendor}`);
  await expect(page.getByRole("main")).toContainText("Invoices go");
  await expect(page.getByRole("main")).toContainText("Weekly");
  await expect(page.getByRole("main")).toContainText("Email approved invoices");
});
