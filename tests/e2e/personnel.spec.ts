import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { laterLocalInput } from "./clock";
import { E2E, E2E_EXTRA_USERS } from "./env";
import { FIXTURE, WARNING_TEXT } from "./personnel-fixtures";
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

async function query<T>(sql: string, params: unknown[]): Promise<T> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    const { rows } = await client.query(sql, params);
    return rows[0] as T;
  } finally {
    await client.end();
  }
}

const jobId = async (title: string) => (await query<{ id: string }>("select id from jobs where title = $1", [title])).id;
const invoiceId = async (title: string) =>
  (await query<{ id: string }>("select i.id from invoices i join assignments a on a.id = i.assignment_id join jobs j on j.id = a.job_id where j.title = $1", [title])).id;
const assignmentId = async (title: string) =>
  (await query<{ id: string }>("select a.id from assignments a join jobs j on j.id = a.job_id where j.title = $1", [title])).id;

/** Map tiles come from an outside server; the suite never depends on it. */
async function blockTiles(page: Page) {
  await page.route(/tile\.openstreetmap\.org/, (r) => r.abort());
}

type Screen = { name: string; path: () => Promise<string>; heading: string | RegExp };

// Every path is a promise, since some screens look up a record id first; `at` gives a fixed path in that shape.
const at = (path: string) => () => Promise.resolve(path);
const SCREENS: Screen[] = [
  { name: "home", path: at("/home"), heading: /^Hi, Sam/ },
  { name: "jobs", path: at("/jobs"), heading: "Details" },
  { name: "job", path: async () => `/jobs/${await jobId(FIXTURE.flexJob)}`, heading: FIXTURE.flexJob },
  { name: "calendar", path: at("/calendar"), heading: "Calendar" },
  { name: "map", path: at("/map"), heading: "Map" },
  { name: "billing", path: at("/billing"), heading: "Billing" },
  { name: "billing-history", path: at("/billing?tab=history"), heading: "Billing" },
  { name: "bill", path: async () => `/billing/bill/${await assignmentId(FIXTURE.pastJob)}`, heading: "Bill this detail" },
  { name: "earnings", path: at("/billing/earnings"), heading: "Earnings" },
  { name: "invoice", path: async () => `/invoices/${await invoiceId(FIXTURE.invoicedJob)}`, heading: /^Invoice / },
  { name: "messages", path: at("/messages"), heading: "Messages" },
  { name: "message-new", path: at("/messages/new"), heading: "New message" },
  { name: "profile", path: at("/profile"), heading: "Profile" },
  { name: "alerts", path: at("/alerts"), heading: "Alerts" },
];

for (const theme of THEMES) {
  test.describe(`personnel screens, ${theme.name}`, () => {
    test.use({ colorScheme: theme.colorScheme });

    for (const screen of SCREENS) {
      test(`${screen.name} at phone and desktop sizes`, async ({ page, context }) => {
        await signInAs(context, "deputy");
        await blockTiles(page);
        const path = await screen.path();
        for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
          await page.setViewportSize(viewport);
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1, name: screen.heading })).toBeVisible();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, "no sideways page scroll").toBeLessThanOrEqual(0);
          await page.screenshot({ path: `${E2E.screenshotDir}/personnel-${screen.name}-${size}-${theme.name}.png`, fullPage: true });
          await expectNoSeriousA11yIssues(page);
        }
      });
    }
  });
}

test("a deputy signs up after accepting the warning and sees the job on Home and Calendar", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(PHONE);
  await page.goto("/jobs");
  await page.getByRole("link", { name: new RegExp(FIXTURE.openJob) }).click();
  await expect(page.getByRole("heading", { level: 1, name: FIXTURE.openJob })).toBeVisible();
  // Met rules are listed (folded), but a passing suspension check is not: suspension is a personnel matter.
  await page.getByRole("button", { name: /^All checks passed/ }).click();
  await expect(page.getByText("Your rank qualifies")).toBeVisible();
  await expect(page.locator("body")).not.toContainText(/suspen/i);
  await page.getByRole("button", { name: /^All checks passed/ }).click();

  await page.getByRole("button", { name: "Sign up for Deputy Sheriff" }).click();
  const dialog = page.getByRole("dialog", { name: "Before you sign up" });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(WARNING_TEXT);
  await expectNoSeriousA11yIssues(page);
  await dialog.getByRole("button", { name: "Accept and sign up" }).click();
  await expect(page.getByRole("status").filter({ hasText: "You are signed up." })).toBeVisible();
  await expect(page.getByText("You are signed up for this detail")).toBeVisible();

  await page.goto("/home");
  const upNext = page.getByRole("region", { name: "Up next" });
  await expect(upNext).toContainText(FIXTURE.openJob);
  await expect(upNext).toContainText("Harborfront Arts");

  await page.goto("/calendar?view=list");
  await expect(page.getByRole("main")).toContainText(FIXTURE.openJob);
  await expect(page.getByRole("main")).toContainText("Signed up");
});

test("a capped deputy sees the exact cap message and a disabled button", async ({ page, context }) => {
  await signInAs(context, "capped");
  await page.setViewportSize(PHONE);
  await page.goto(`/jobs/${await jobId(FIXTURE.cappedJob)}`);
  await expect(page.getByText("24-hour cap: 18 of 16 hours in any 24 hours with this detail")).toBeVisible();
  await expect(page.getByRole("button", { name: "Sign up for Deputy Sheriff" })).toBeDisabled();
  await page.screenshot({ path: `${E2E.screenshotDir}/personnel-capped-phone-day.png`, fullPage: true });
});

test("billing with changed hours requires a reason", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(PHONE);
  await page.goto("/billing");
  const card = page.getByRole("article").filter({ hasText: FIXTURE.pastJob });
  await card.getByRole("link", { name: "Review and send invoice" }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Bill this detail" })).toBeVisible();

  const end = page.getByLabel("End", { exact: true });
  // Forty minutes later, into the next day when the detail ended late in the evening.
  await end.fill(laterLocalInput(await end.inputValue(), 40));
  await expect(page.getByText("Hours changed, so a reason is required")).toBeVisible();

  await page.getByRole("button", { name: /^(Send invoice|Submit for review)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: "A reason is required when the hours changed." })).toBeVisible();

  await page.getByRole("button", { name: "Vendor asked me to stay" }).click();
  await expect(page.getByLabel("Reason")).toHaveValue("Vendor asked me to stay");
  await page.getByRole("button", { name: "Submit for review" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Invoice sent to a coordinator for review." })).toBeVisible();
});

test("the personal .ics feed lists the deputy's own details and stops when turned off", async ({ page, context, request }) => {
  await signInAs(context, "capped");
  await page.setViewportSize(DESKTOP);
  await page.goto("/calendar");
  await page.getByRole("button", { name: "Make calendar link" }).click();
  const field = page.getByLabel("Your calendar link");
  await expect(field).toHaveValue(/\/api\/v1\/calendar\.ics\?token=/);
  const url = await field.inputValue();

  const res = await request.get(url);
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toContain("text/calendar");
  const body = await res.text();
  expect(body).toContain(`Harborfront Arts: ${FIXTURE.cappedHeld}`);
  expect(body).not.toContain(FIXTURE.openJob);
  expect(body).not.toContain("Sam Whitley");

  await page.getByRole("button", { name: "Turn off link" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Calendar link turned off." })).toBeVisible();
  expect((await request.get(url)).status()).toBe(404);
});

test("alerts: the bell shows unread alerts and the list marks them read", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(DESKTOP);
  await page.goto("/home");
  await page.locator('[data-shell="top-nav"]').getByRole("link", { name: /^Alerts, \d+ unread$/ }).click();
  await expect(page.getByRole("heading", { level: 1, name: "Alerts" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.alert) })).toHaveAttribute("href", "/jobs");
  await page.getByRole("button", { name: "Mark all read" }).click();
  await expect(page.getByRole("status").filter({ hasText: "All alerts marked read." })).toBeVisible();
  await expect(page.getByText("You are all caught up.")).toBeVisible();
  await expect(page.locator('[data-shell="top-nav"]').getByRole("link", { name: "Alerts", exact: true })).toBeVisible();
});

test("personnel never see an unapproved vendor request", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.goto("/jobs");
  await expect(page.getByRole("heading", { level: 1, name: "Details" })).toBeVisible();
  await expect(page.getByRole("main")).not.toContainText(FIXTURE.requestedJob);
  const res = await page.goto(`/jobs/${await jobId(FIXTURE.requestedJob)}`);
  expect(res?.status()).toBe(404);
});

test("search finds details by vendor name and by job number", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(DESKTOP);
  await page.goto("/jobs?q=Coastal");
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.flexJob) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.openJob) })).toHaveCount(0);
  const { number } = await query<{ number: number }>("select number from jobs where title = $1", [FIXTURE.openJob]);
  await page.goto(`/jobs?q=%23${number}`);
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.openJob) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.flexJob) })).toHaveCount(0);
});

test("the job page offers each position the deputy can take", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(PHONE);
  await page.goto(`/jobs/${await jobId(FIXTURE.flexJob)}`);
  await expect(page.getByRole("radio", { name: "Deputy Sheriff (2 open)" })).toBeChecked();
  await page.getByRole("radio", { name: "CSO (1 open)" }).check();
  await expect(page.getByRole("button", { name: "Sign up for CSO" })).toBeEnabled();
  await expect(page.getByText(/^All checks passed \(\d+\)$/)).toBeVisible();
});

test("on a phone the Details filters open from the Filters button (the shared panel)", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(PHONE);
  await page.goto("/jobs?f=1");
  const panel = page.getByRole("complementary", { name: "Filters" });
  await expect(panel.getByLabel("Search")).toBeHidden();
  await panel.getByRole("button", { name: "Filters" }).click();
  await panel.getByLabel("Search").fill("Coastal");
  await expectNoSeriousA11yIssues(page);
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/q=Coastal/);
  await expect(page.getByRole("button", { name: "Filters (1 on)" })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.flexJob) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.openJob) })).toHaveCount(0);
  await page.getByRole("complementary", { name: "Filters" }).getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("complementary", { name: "Filters" }).getByRole("button", { name: "Reset" }).click();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.openJob) })).toBeVisible();
});

test("the deputy-only filters sit in the shared panel and are remembered for that deputy", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.setViewportSize(PHONE);
  await page.goto("/jobs?f=1");
  const panel = page.getByRole("complementary", { name: "Filters" });
  await panel.getByRole("button", { name: "Filters" }).click();
  await panel.getByLabel("Flexible times").check();
  await panel.getByLabel("Sort by").selectOption("total_pay");
  await panel.getByLabel("Remember my filters").check();
  await expect(panel.getByText("Only details I can work")).toBeVisible();
  await expectNoSeriousA11yIssues(page);
  await page.screenshot({ path: `${E2E.screenshotDir}/t39a-jobs-filters-phone-day.png`, fullPage: true });
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/flex=1/);
  await expect(page).toHaveURL(/sort=total_pay/);
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.flexJob) })).toBeVisible();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.openJob) })).toHaveCount(0);
  // A plain visit uses this deputy's remembered filters.
  await page.goto("/jobs");
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.openJob) })).toHaveCount(0);
  // The Calendar does not show or count the deputy-only filters.
  await page.goto("/calendar");
  await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  await page.goto("/jobs");
  await page.getByRole("complementary", { name: "Filters" }).getByRole("button", { name: /^Filters/ }).click();
  await page.getByRole("complementary", { name: "Filters" }).getByRole("button", { name: "Reset" }).click();
  await expect(page.getByRole("link", { name: new RegExp(FIXTURE.openJob) })).toBeVisible();
});

test("vendors are sent to their own pages and coordinators get the staff invoice view", async ({ page, context }) => {
  await signInAs(context, "vendor");
  await page.goto("/home");
  await expect(page).not.toHaveURL(/\/home$/);
  await page.goto(`/jobs/${await jobId(FIXTURE.openJob)}`);
  await expect(page).not.toHaveURL(/\/jobs\//);
  await page.goto(`/invoices/${await invoiceId(FIXTURE.invoicedJob)}`);
  await expect(page).toHaveURL(/\/vendor\/invoices$/);
  await context.clearCookies();
  await signInAs(context, "coordinator");
  await page.goto(`/invoices/${await invoiceId(FIXTURE.invoicedJob)}`);
  await expect(page.getByRole("link", { name: "Back to payments" })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Sam Whitley");
});

test("a deputy cannot open another deputy's invoice, bill or invoice PDF", async ({ page, context }) => {
  await signInAs(context, "capped");
  const inv = await invoiceId(FIXTURE.invoicedJob);
  expect((await page.goto(`/invoices/${inv}`))?.status()).toBe(404);
  const pdf = await page.request.get(`/api/v1/invoices/${inv}/pdf`);
  expect(pdf.status()).toBe(404);
  expect(pdf.headers()["content-disposition"]).toBeUndefined();
  await page.goto(`/billing/bill/${await assignmentId(FIXTURE.invoicedJob)}`);
  await expect(page.getByText("Nothing to bill here")).toBeVisible();
  expect((await page.request.get(`/api/v1/me/w9`)).status()).toBe(404);
});

test("a sign-up a suspension removed reads as a plain Canceled on Home and in My details", async ({ page, context }) => {
  await signInAs(context, "suspensionRemoved");
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto("/home");
    // In Up next it carries the Canceled chip, not a plain upcoming row. (The open spot may also be offered elsewhere on Home.)
    const row = page.getByRole("region", { name: "Up next" }).getByRole("listitem").filter({ hasText: FIXTURE.suspensionRemovedJob });
    await expect(row).toHaveCount(1);
    await expect(row.getByText("Canceled", { exact: true })).toBeVisible();
    await expect(row.getByText("Your sign-up was canceled.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/suspen/i);
    await page.screenshot({ path: `${E2E.screenshotDir}/personnel-suspension-removed-home-${size}.png`, fullPage: true });

    await page.goto("/jobs?mine=1");
    const listed = page.getByRole("listitem").filter({ hasText: FIXTURE.suspensionRemovedJob });
    await expect(listed).toHaveCount(1);
    await expect(listed.getByText("Canceled", { exact: true })).toBeVisible();
    await expect(listed.getByText("Your sign-up was canceled.")).toBeVisible();
    await expect(page.locator("body")).not.toContainText(/suspen/i);
  }
});

test("Enter on a schedule chip picks it and never saves the half-edited schedule", async ({ page, context }) => {
  await signInAs(context, "capped");
  await page.setViewportSize(DESKTOP);
  await page.goto("/profile");
  const actions: string[] = [];
  page.on("request", (r) => {
    if (r.method() === "POST" && r.headers()["next-action"]) actions.push(r.url());
  });

  const rotation = page.getByRole("radio", { name: "Rotation" });
  await rotation.focus();
  await page.keyboard.press("Enter");
  await expect(rotation).toBeChecked();
  await expect(page.getByLabel("First work day")).toBeVisible();

  const buffer = page.getByRole("radio", { name: "30 min" });
  await buffer.focus();
  await page.keyboard.press("Enter");
  await expect(buffer).toBeChecked();

  // Arrow keys still move the choice within the group.
  await page.keyboard.press("ArrowRight");
  await expect(page.getByRole("radio", { name: "45 min" })).toBeChecked();

  await expect(page.getByRole("status").filter({ hasText: "Schedule saved." })).toHaveCount(0);
  expect(actions).toEqual([]);

  try {
    // The Save button still submits, and the listener sees that one request.
    await page.getByRole("button", { name: "Save schedule" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Schedule saved." })).toBeVisible();
    expect(actions).toHaveLength(1);

    // Other tests sign up as this deputy with no schedule in force: turn it off again.
    await page.reload();
    await page.getByRole("button", { name: "Turn off schedule" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Schedule turned off." })).toBeVisible();
  } finally {
    // Even after a failure above, leave no schedule in force (what "Turn off schedule" stores).
    await query("update work_schedules set active = false where user_id = (select id from users where email = $1)", [E2E_EXTRA_USERS.capped.email]);
  }
});
