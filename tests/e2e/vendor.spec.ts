import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { COORD } from "./coordinator-fixtures";
import { E2E } from "./env";
import { signInAs } from "./session";
import { VENDOR } from "./vendor-fixtures";

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };
const THEMES = [
  { name: "day", colorScheme: "light" },
  { name: "night", colorScheme: "dark" },
] as const;
const TZ = "America/Chicago";

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

const jobId = async (title: string) => (await rows<{ id: string }>("select id from jobs where title = $1", [title]))[0].id;
/** YYYY-MM-DD in agency time, `days` from today. */
const agencyDate = (days: number) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(Date.now() + days * 86_400_000));
/** "Dec 3" in agency time. */
const monthDay = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: TZ, month: "short", day: "numeric" }).format(d);

type Screen = { name: string; path: () => Promise<string>; heading: string | RegExp };

// Every path is a promise, since some screens look up a record id first; `at` gives a fixed path in that shape.
const at = (path: string) => () => Promise.resolve(path);
const SCREENS: Screen[] = [
  { name: "details", path: at("/vendor"), heading: "My details" },
  { name: "calendar", path: at("/vendor?view=calendar"), heading: "My details" },
  { name: "request", path: at("/vendor/request"), heading: "Request a detail" },
  { name: "detail", path: async () => `/vendor/details/${await jobId(VENDOR.filledJob)}`, heading: VENDOR.filledJob },
  { name: "invoices", path: at("/vendor/invoices"), heading: "Invoices" },
  { name: "locations", path: at("/vendor/locations"), heading: "Locations" },
  { name: "contracts", path: at("/vendor/contracts"), heading: "Contracts" },
];

for (const theme of THEMES) {
  test.describe(`vendor screens, ${theme.name}`, () => {
    test.use({ colorScheme: theme.colorScheme });

    for (const screen of SCREENS) {
      test(`${screen.name} at phone and desktop sizes`, async ({ page, context }) => {
        await signInAs(context, "vendor");
        const path = await screen.path();
        for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
          await page.setViewportSize(viewport);
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1, name: screen.heading })).toBeVisible();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, "no sideways page scroll").toBeLessThanOrEqual(0);
          await page.screenshot({ path: `${E2E.screenshotDir}/vendor-${screen.name}-${size}-${theme.name}.png`, fullPage: true });
          await expectNoSeriousA11yIssues(page);
        }
      });
    }
  });
}

test("the calendar never scrolls sideways, in a six-week month and with long names in every column", async ({ page, context }) => {
  await signInAs(context, "vendor");
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP], ["tablet", { width: 768, height: 900 }], ["laptop", { width: 1024, height: 800 }]] as const) {
    await page.setViewportSize(viewport);
    for (const month of VENDOR.calendarMonths) {
      await page.goto(`/vendor?view=calendar&month=${month}`);
      await expect(page.getByRole("table")).toBeVisible();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, `${month} at ${size}: no sideways page scroll`).toBeLessThanOrEqual(0);
    }
  }
  // March 2031 starts on a Saturday: six week rows.
  await page.setViewportSize(DESKTOP);
  await page.goto("/vendor?view=calendar&month=2031-03");
  await expect(page.getByRole("table").locator("tbody tr")).toHaveCount(6);
});

test("a vendor requests a detail, a coordinator approves it, and a time change waits for a coordinator", async ({ page, context, browser }) => {
  const title = "Summer concert series";
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await page.goto("/vendor/request");
  await page.getByLabel("Location", { exact: true }).selectOption({ label: `${VENDOR.location}, ${VENDOR.address}` });
  await page.getByLabel("Date", { exact: true }).fill(agencyDate(10));
  await page.getByLabel("Start", { exact: true }).fill("18:00");
  await page.getByLabel("End", { exact: true }).fill("22:00");
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Position", { exact: true }).selectOption({ label: "Deputy Sheriff" });
  await page.getByLabel("How many", { exact: true }).fill("2");
  await page.getByLabel("What the deputies will do").fill("Crowd and parking for the lawn concert. Check in at the amphitheater stage.");
  // A new site contact is saved to the vendor for future details.
  await page.getByLabel("Site contact", { exact: true }).selectOption({ label: "Add a new contact" });
  await page.getByLabel("Contact name").fill("Events office");
  await page.getByLabel("Contact phone").fill("8505550142");
  await expect(page.getByLabel("Contact phone")).toHaveValue("850-555-0142");
  // A file chosen and then put away by closing Attachments is not sent, and the section reopens empty.
  await page.getByRole("button", { name: "Attachments" }).click();
  await page.getByLabel("Contract file").setInputFiles({ name: "draft.pdf", mimeType: "application/pdf", buffer: Buffer.from("%PDF-1.4\ndraft") });
  await expect(page.getByLabel("Or a contract link")).toBeDisabled();
  await expect(page.getByText("A file is attached. Remove the file to send a link instead.")).toBeVisible();
  await page.getByRole("button", { name: "Attachments" }).click();
  await page.getByRole("button", { name: "Attachments" }).click();
  await expect(page.getByLabel("Or a contract link")).toBeEnabled();
  await expect(page.getByRole("button", { name: "Remove draft.pdf" })).toHaveCount(0);
  await page.getByRole("button", { name: "Attachments" }).click();
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByText("Waiting for coordinator approval")).toBeVisible();
  const id = await jobId(title);
  expect(await rows("select id from job_attachments where job_id = $1", [id])).toEqual([]);
  expect((await rows<{ state: string; contact_phone: string }>("select state, contact_phone from jobs where id = $1", [id]))[0]).toEqual({ state: "requested", contact_phone: "850-555-0142" });
  expect(await rows("select name, phone, active from vendor_contacts where name = 'Events office'")).toEqual([{ name: "Events office", phone: "850-555-0142", active: true }]);

  // A coordinator approves it on the existing screen.
  const staff = await browser.newContext();
  await signInAs(staff, "coordinator");
  const coord = await staff.newPage();
  await coord.goto(`/jobs/${id}?tab=manage`);
  await coord.getByRole("button", { name: "Approve request" }).click();
  await expect(coord.getByRole("status").filter({ hasText: "Request approved." })).toBeVisible();
  await staff.close();

  // The vendor sees it scheduled.
  await page.goto("/vendor");
  const row = page.getByRole("listitem").filter({ hasText: title });
  await expect(row).toContainText("Scheduled");
  await row.getByRole("link", { name: new RegExp(title) }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();

  // A time change outside the edit lock goes to a coordinator.
  await page.getByRole("button", { name: "Change detail" }).click();
  await page.getByLabel("End", { exact: true }).fill("23:00");
  await page.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Waiting for coordinator approval" })).toBeVisible();
  await page.reload();
  await expect(page.getByText("Waiting for coordinator approval")).toBeVisible();
  expect((await rows<{ n: string }>("select count(*) as n from job_change_requests where job_id = $1 and status = 'pending'", [id]))[0].n).toBe("1");
  await page.screenshot({ path: `${E2E.screenshotDir}/vendor-change-waiting-phone.png`, fullPage: true });
});

test("a vendor requests three dates with flexible times, a safety address and a contract file, and a coordinator approves them at once", async ({ page, context, browser }) => {
  const title = "Spring market mornings";
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await page.goto("/vendor/request");
  await page.getByLabel("Location", { exact: true }).selectOption({ label: `${VENDOR.location}, ${VENDOR.address}` });
  await page.getByLabel("Date", { exact: true }).fill(agencyDate(14));
  await page.getByLabel("Start", { exact: true }).fill("08:00");
  await page.getByLabel("End", { exact: true }).fill("12:00");
  await page.getByLabel("Title", { exact: true }).fill(title);

  // The optional parts stay folded away until asked for.
  await expect(page.getByLabel("Earliest start")).toHaveCount(0);
  await page.getByRole("button", { name: "Flexible times" }).click();
  await page.getByLabel("Earliest start").fill("07:30");
  await page.getByLabel("Latest finish").fill("12:30");
  await page.getByLabel(/Allow shorter shifts/).check();

  await page.getByRole("button", { name: "More dates" }).click();
  await page.getByLabel("From", { exact: true }).fill(agencyDate(15));
  await page.getByLabel("To", { exact: true }).fill(agencyDate(16));
  await expect(page.getByText("3 details will be requested")).toBeVisible();

  await page.getByRole("button", { name: "Officer safety" }).click();
  await page.getByLabel("Safety notes").fill("A former vendor employee has made threats about the market.");
  await page.getByRole("button", { name: "Add an address" }).click();
  await page.getByLabel("Address of concern 1").fill("88 Lake Shore Dr, Gulf Haven, FL 32400");
  await page.getByLabel("What to know").fill("Former employee's home");

  await page.getByRole("button", { name: "Attachments" }).click();
  await page.getByLabel("Contract name").fill("Market season contract");
  await page.getByLabel("Contract file").setInputFiles({ name: "market-contract.pdf", mimeType: "application/pdf", buffer: Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("contract ".repeat(40))]) });
  await page.screenshot({ path: `${E2E.screenshotDir}/vendor-request-optional-phone.png`, fullPage: true });
  await page.getByRole("button", { name: "Send request" }).click();

  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  const made = await rows<{ id: string; series_id: string; state: string; flex_allow_shorter: boolean; flex_earliest_start_at: Date | null }>(
    "select id, series_id, state, flex_allow_shorter, flex_earliest_start_at from jobs where title = $1 order by start_at",
    [title],
  );
  expect(made).toHaveLength(3);
  expect(new Set(made.map((j) => j.series_id)).size).toBe(1);
  expect(made.every((j) => j.state === "requested" && j.flex_allow_shorter && j.flex_earliest_start_at !== null)).toBe(true);
  const ids = made.map((j) => j.id);
  expect((await rows<{ n: string }>("select count(*) as n from job_safety_addresses where job_id = any($1)", [ids]))[0].n).toBe("3");
  const files = await rows<{ file_id: string }>("select file_id from job_attachments where job_id = any($1) and is_contract", [ids]);
  expect(files).toHaveLength(3);
  expect(new Set(files.map((f) => f.file_id)).size).toBe(1);

  const staff = await browser.newContext();
  await signInAs(staff, "coordinator");
  const coord = await staff.newPage();
  await coord.goto(`/jobs/${ids[1]}?tab=manage`);
  await coord.getByRole("button", { name: "Approve request" }).click();
  await expect(coord.getByRole("status").filter({ hasText: "Request approved for 3 dates." })).toBeVisible();
  await staff.close();
  expect((await rows<{ state: string }>("select state from jobs where id = any($1)", [ids])).map((r) => r.state)).toEqual(["scheduled", "scheduled", "scheduled"]);
});

test("a vendor sees the assigned names once filled and cannot change a detail inside the edit lock", async ({ page, context }) => {
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await page.goto(`/vendor/details/${await jobId(VENDOR.filledJob)}`);
  const main = page.getByRole("main");
  await expect(main).toContainText(VENDOR.deputy.name);
  await expect(main).not.toContainText(VENDOR.deputy.phone);
  await expect(main).not.toContainText(VENDOR.deputy.email);
  await expect(page.getByRole("button", { name: "Change detail" })).toBeDisabled();
  await expect(main).toContainText("Changes are not allowed within 24 hours of the start. Call the coordinators.");
  await expect(page.getByRole("button", { name: "Cancel detail" })).toBeDisabled();
  await expect(main).toContainText("Cancellations close 24 hours before the start. Call the coordinators.");
});

test("a vendor marks a sent invoice paid by Ramp and the deputy sees Vendor reports paid", async ({ page, context, browser }) => {
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await page.goto("/vendor/invoices");
  const card = page.getByRole("article").filter({ hasText: VENDOR.invoicedJob });
  await expect(card).toContainText(VENDOR.deputy.name);
  await expect(card).toContainText("$260 at $65/hr");
  await card.getByRole("button", { name: /^Mark paid/ }).click();
  await card.getByLabel("Date paid").fill(agencyDate(0));
  await card.getByLabel("Method").selectOption({ label: "Ramp" });
  await card.getByLabel("Check or reference number").fill("RMP-2291");
  await card.getByRole("button", { name: "Record payment" }).click();
  await expect(card.getByRole("status")).toContainText("Marked paid. The deputy confirms when the money arrives.");
  await expect(card).toContainText(`You marked this paid on ${monthDay(new Date())} by Ramp, #RMP-2291.`);

  const deputy = await browser.newContext();
  await signInAs(deputy, "avery");
  const d = await deputy.newPage();
  await d.goto("/billing");
  await expect(d.getByRole("main")).toContainText(`Vendor reports paid on ${monthDay(new Date())} by Ramp, #RMP-2291.`);
  await deputy.close();
});

test("an oversize request upload is refused with 413 before it is read", async ({ context }) => {
  await signInAs(context, "vendor");
  const res = await context.request.post("/api/v1/vendor-requests", {
    multipart: { request: "{}", contractFile: { name: "huge.pdf", mimeType: "application/pdf", buffer: Buffer.alloc(21 * 1024 * 1024) } },
  });
  expect(res.status()).toBe(413);
  expect((await res.json()).error.message).toBe("The upload is too large. A contract file can be at most 20 MB.");
});

test("another vendor's detail is not found", async ({ page, context }) => {
  await signInAs(context, "vendor");
  const res = await page.goto(`/vendor/details/${await jobId(COORD.unfilledJob)}`);
  expect(res?.status()).toBe(404);
});

test("vendor locations open in the person's maps app", async ({ page, context }) => {
  await signInAs(context, "vendor");
  await page.setViewportSize(PHONE);
  await page.goto("/vendor/locations");
  const item = page.getByRole("listitem").filter({ hasText: VENDOR.location });
  await expect(item).toContainText(VENDOR.address);
  await item.getByRole("button", { name: /Open in Maps/ }).click();
  await expect(item.getByRole("link", { name: /Google Maps/ })).toBeVisible();
  await expect(item.getByRole("link", { name: /Apple Maps/ })).toBeVisible();
  await expect(item.getByRole("link", { name: /OpenStreetMap/ })).toBeVisible();
});
