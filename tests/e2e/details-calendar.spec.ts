import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";
import { COORD } from "./coordinator-fixtures";
import { E2E } from "./env";
import { signInAs } from "./session";

/** Task 39a: release fix, Hold and Release, the new detail summary, position pay, quick and bulk edit, and the agency calendar. */

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

async function noSideScroll(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, "no sideways page scroll").toBeLessThanOrEqual(0);
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
const shot = (page: Page, name: string) => page.screenshot({ path: `${E2E.screenshotDir}/t39a-${name}.png`, fullPage: true });

/** An agency date key `days` from today. */
function dayKey(days: number): string {
  const p = agencyDateParts(new Date(Date.now() + days * 86_400_000));
  return `${p.year}-${String(p.month).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

/** A detail written straight to the database for the school vendor, `days` out at 17:00 to 21:00 agency time. */
async function makeJob(title: string, days: number, o: { releaseInFuture?: boolean; vendor?: string; count?: number } = {}): Promise<string> {
  const vendor = await one<{ id: string }>("select id from vendors where name = $1", [o.vendor ?? COORD.vendor]);
  const type = await one<{ id: string }>("select id from job_types order by sort_order limit 1");
  const ds = await one<{ id: string }>("select id from position_types where name = 'Deputy Sheriff'");
  const key = dayKey(days);
  const job = await one<{ id: string }>(
    `insert into jobs (id, vendor_id, type_id, title, start_at, end_at, rate_cents, state, release_at)
     values (gen_random_uuid()::text, $1, $2, $3, ($4 || ' 17:00')::timestamp at time zone 'America/Chicago', ($4 || ' 21:00')::timestamp at time zone 'America/Chicago', 6500, 'scheduled', $5) returning id`,
    [vendor.id, type.id, title, key, o.releaseInFuture ? new Date(Date.now() + 20 * 86_400_000) : new Date(Date.now() - 86_400_000)],
  );
  await rows("insert into job_positions (id, job_id, position_type_id, count) values (gen_random_uuid()::text, $1, $2, $3)", [job.id, ds.id, o.count ?? 2]);
  return job.id;
}

test("a coordinator-created detail this month is open for sign-up without any state change", async ({ page, context, browser }) => {
  const title = "Release regression, tomorrow";
  const key = dayKey(1);
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/jobs/new");
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: COORD.vendor });
  await page.getByLabel("Title", { exact: true }).fill(title);
  await page.getByLabel("Start time").fill("17:00");
  await page.getByLabel("End time").fill("21:00");
  await page.getByRole("tab", { name: "Range" }).click();
  await page.getByLabel("From", { exact: true }).fill(key);
  await page.getByLabel("To", { exact: true }).fill(key);
  await expect(page.getByText("1 detail will be created")).toBeVisible();
  await page.getByRole("button", { name: "Create detail" }).click();
  await expect(page.getByRole("heading", { level: 1, name: title })).toBeVisible();
  await expect(page.getByRole("main")).toContainText("Released");
  const job = await one<{ id: string; state: string }>("select id, state from jobs where title = $1", [title]);
  expect(job.state).toBe("scheduled");

  const deputy = await browser.newContext({ viewport: PHONE });
  await signInAs(deputy, "deputy");
  const p = await deputy.newPage();
  await p.goto(`/jobs/${job.id}`);
  await expect(p.getByRole("button", { name: "Sign up for Deputy Sheriff" })).toBeEnabled();
  await p.goto("/jobs?open=1");
  await expect(p.getByRole("main")).toContainText(title);
  await deputy.close();
});

test("Hold and Release now on the detail page, at phone size", async ({ page, context }) => {
  const id = await makeJob("Hold and release check", 30, { releaseInFuture: true });
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto(`/jobs/${id}?tab=manage`);
  await expect(page.getByTestId("release-state")).toContainText("Opens");
  await page.getByRole("button", { name: "Hold", exact: true }).click();
  await expect(page.getByRole("status").filter({ hasText: "Held." })).toBeVisible();
  await expect(page.getByTestId("release-state")).toContainText("Held: off the open lists");
  expect((await one<{ held: boolean }>("select held from jobs where id = $1", [id])).held).toBe(true);
  await shot(page, "hold-phone-day");
  await expectNoSeriousA11yIssues(page);

  await page.getByRole("button", { name: "Release now" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Open for sign-up now." })).toBeVisible();
  const after = await one<{ held: boolean; open: boolean }>("select held, release_at <= now() as open from jobs where id = $1", [id]);
  expect(after).toEqual({ held: false, open: true });
  await expect(page.getByTestId("release-state")).toContainText("Open for sign-up since");
  const audit = await rows<{ action: string }>("select action from audit_log where entity_id = $1 and action in ('job.hold','job.release_hold','job.release_now') order by at, id", [id]);
  expect(audit.map((a) => a.action)).toEqual(["job.hold", "job.release_hold", "job.release_now"]);
});

test("the new detail summary prices each date on its own times and adds positions without duplicates", async ({ page, context }) => {
  const year = agencyDateParts(new Date()).month === 12 ? agencyDateParts(new Date()).year + 1 : agencyDateParts(new Date()).year;
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/jobs/new");
  await page.getByLabel("Vendor", { exact: true }).selectOption({ label: COORD.vendor });
  await page.getByLabel("Title", { exact: true }).fill("Summary per date check");
  await page.getByLabel("Start time").fill("09:00");
  await page.getByLabel("End time").fill("13:00");
  await page.getByRole("tab", { name: "Range" }).click();
  await page.getByLabel("From", { exact: true }).fill(`${year}-12-08`);
  await page.getByLabel("To", { exact: true }).fill(`${year}-12-09`);
  await expect(page.getByText("2 details will be created")).toBeVisible();
  // School default $65/hr: 4 hours is $260 per deputy per date.
  await expect(page.getByTestId("summary-total")).toHaveText("$520");

  const label = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }).format(new Date(`${year}-12-09T12:00:00Z`));
  await page.getByRole("button", { name: `Change times, ${label}` }).click();
  await page.getByLabel(`End, ${label}`).fill("15:00");
  // $260 + $390.
  await expect(page.getByTestId("summary-total")).toHaveText("$650");
  await expect(page.getByTestId("summary-each")).toContainText("$260");
  await expect(page.getByTestId("summary-each")).toContainText("$390");

  // Add position starts on Deputy Sheriff, and adding it again raises the count.
  await expect(page.getByLabel("Position to add")).toHaveValue(await one<{ id: string }>("select id from position_types where name = 'Deputy Sheriff'").then((r) => r.id));
  await page.getByRole("button", { name: "Add position" }).click();
  await expect(page.getByLabel("Position 2", { exact: true })).toHaveCount(0);
  await expect(page.getByLabel("Count")).toHaveValue("2");
  await expect(page.getByTestId("summary-total")).toHaveText("$1,300");

  // An Incident Commander earns $25.00 an hour more.
  await page.getByLabel("Position to add").selectOption({ label: "Incident Commander" });
  await page.getByRole("button", { name: "Add position" }).click();
  await expect(page.getByLabel("Position 2", { exact: true })).toBeVisible();
  await expect(page.getByText("Pays $90/hr: $25 over the detail's rate.")).toBeVisible();
  // Per date: IC $360 and $540 on top of $1,300.
  await expect(page.getByTestId("summary-total")).toHaveText("$2,200");
  // The date with its own times shows its own range: Deputy Sheriff $390 to Incident Commander $540.
  await expect(page.getByText("Dates with their own times")).toBeVisible();
  await expect(page.getByRole("main")).toContainText("$390 to $540 at $65 to $90/hr");
  await shot(page, "new-detail-summary-desktop-day");
  await expectNoSeriousA11yIssues(page);
});

test("Management shows each position type's pay differential", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/admin/positions");
  await expect(page.getByRole("listitem").filter({ hasText: "Incident Commander" }).first()).toContainText("Pays $25/hr over the detail's rate");
  await page.getByRole("button", { name: "Edit Incident Commander" }).click();
  await expect(page.getByLabel("Pay differential per hour")).toHaveValue("25");
  await shot(page, "positions-phone-day");
  await expectNoSeriousA11yIssues(page);
});

test("quick edit changes rate and times in place at phone size", async ({ page, context }) => {
  const id = await makeJob("Quick edit check", 12);
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto(`/jobs/${id}?tab=manage`);
  const form = page.getByRole("form", { name: "Quick edit" });
  await form.getByLabel("Rate per hour").fill("75");
  await form.getByLabel("End time").fill("22:00");
  await form.getByLabel("Description").fill("Bring a reflective vest.");
  await shot(page, "quick-edit-phone-day");
  await expectNoSeriousA11yIssues(page);
  await noSideScroll(page);
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  const job = await one<{ rate_cents: number; end: string; description: string }>(
    "select rate_cents, to_char(end_at at time zone 'America/Chicago', 'HH24:MI') as end, description from jobs where id = $1",
    [id],
  );
  expect(job).toEqual({ rate_cents: 7500, end: "22:00", description: "Bring a reflective vest." });
});

test("bulk edit across two vendors with a preview, at phone size", async ({ page, context }) => {
  await rows("insert into vendors (id, name, default_rate_cents, billing_emails) values (gen_random_uuid()::text, 'Bulk Edit Second Vendor', 6000, '{ap@bulk.example}') on conflict do nothing");
  const a = await makeJob("Bulk edit first", 14);
  const b = await makeJob("Bulk edit second", 15, { vendor: "Bulk Edit Second Vendor" });
  const [na, nb] = await Promise.all([a, b].map(async (id) => (await one<{ number: number }>("select number from jobs where id = $1", [id])).number));
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/jobs?f=1&q=Bulk%20edit");
  await page.getByRole("checkbox", { name: `Select #${na} Bulk edit first` }).check();
  await page.getByRole("checkbox", { name: `Select #${nb} Bulk edit second` }).check();
  await page.getByRole("button", { name: "Edit selected" }).click();
  const form = page.getByRole("form", { name: "Bulk edit" });
  await form.getByLabel("New rate per hour").fill("80");
  await form.getByLabel("New start time").fill("16:30");
  await form.getByRole("button", { name: "Preview changes" }).click();
  const preview = page.getByRole("list", { name: "Before and after" });
  await expect(preview.getByRole("listitem")).toHaveCount(2);
  await expect(preview).toContainText("$80/hr");
  await shot(page, "bulk-edit-phone-day");
  await expectNoSeriousA11yIssues(page);
  await noSideScroll(page);
  await page.getByRole("button", { name: "Save all 2 details" }).click();
  await expect(page.getByRole("status").filter({ hasText: "2 details saved." })).toBeVisible();
  const saved = await rows<{ rate_cents: number; start: string }>("select rate_cents, to_char(start_at at time zone 'America/Chicago', 'HH24:MI') as start from jobs where id in ($1, $2)", [a, b]);
  expect(saved).toEqual([
    { rate_cents: 8000, start: "16:30" },
    { rate_cents: 8000, start: "16:30" },
  ]);
});

for (const theme of THEMES) {
  test.describe(`agency calendar, ${theme.name}`, () => {
    test.use({ colorScheme: theme.colorScheme });
    for (const who of ["coordinator", "deputy"] as const) {
      test(`${who}: month, week and list at phone and desktop sizes`, async ({ page, context }) => {
        await signInAs(context, who);
        for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
          await page.setViewportSize(viewport);
          await page.goto("/calendar?f=1");
          await expect(page.getByRole("heading", { level: 1, name: "Calendar" })).toBeVisible();
          await expect(page.getByRole("list", { name: "Color key" })).toBeVisible();
          if (size === "desktop") {
            await expect(page.getByRole("region", { name: "Filters" }).or(page.getByRole("complementary", { name: "Filters" }))).toBeVisible();
            // Entries read "7:00 AM Vendor name".
            const entries = page.locator("td a[title]");
            if ((await entries.count()) > 0) await expect(entries.first()).toContainText(/^\d{1,2}:\d{2} (AM|PM) /);
          } else {
            await expect(page.getByRole("button", { name: /^Filters/ })).toBeVisible();
          }
          await noSideScroll(page);
          await shot(page, `calendar-${who}-month-${size}-${theme.name}`);
          await expectNoSeriousA11yIssues(page);
          await page.goto("/calendar?view=list&f=1");
          await noSideScroll(page);
          await shot(page, `calendar-${who}-list-${size}-${theme.name}`);
          await expectNoSeriousA11yIssues(page);
        }
      });
    }
  });
}

test("on a phone, tapping a day opens that day's list", async ({ page, context }) => {
  await makeJob("Calendar day tap check", 2);
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/calendar?f=1");
  const key = dayKey(2);
  // The month on screen may not hold the day yet (end of month): step forward once if needed.
  const day = page.locator(`td a[href*="date=${key}"]`).filter({ visible: true }).first();
  if ((await day.count()) === 0) await page.getByRole("link", { name: "Next" }).click();
  await expect(day).toHaveAccessibleName(/\b(?:1 detail|\d+ details)/);
  await day.click();
  await expect(page).toHaveURL(new RegExp(`view=day&date=${key}`));
  await expect(page.getByRole("main")).toContainText("Calendar day tap check");
  await shot(page, "calendar-day-phone-day");
});

test("My details only and remembered filters belong to the person, and Reset clears them", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/calendar?view=list&f=1");
  const panel = page.getByRole("complementary", { name: "Filters" });
  await panel.getByLabel("Search").fill("Bulk edit");
  await panel.getByLabel("Remember my filters").check();
  await panel.getByRole("button", { name: "Apply" }).click();
  await expect(page).toHaveURL(/q=Bulk/);
  await expect(page.getByRole("main")).toContainText("Bulk edit first");
  await expect(page.getByRole("main")).not.toContainText("Quick edit check");

  // A plain visit uses the remembered filters.
  await page.goto("/calendar?view=list");
  await expect(page.getByRole("main")).not.toContainText("Quick edit check");
  const saved = await one<{ detail_filters: { remember: boolean; filters: { q: string } } }>("select detail_filters from users where email = 'coordinator@e2e.test'");
  expect(saved.detail_filters.filters.q).toBe("Bulk edit");
  // Nobody else's view changes.
  const other = await one<{ detail_filters: unknown }>("select detail_filters from users where email = 'admin@e2e.test'");
  expect(other.detail_filters).toBeNull();

  await page.getByRole("complementary", { name: "Filters" }).getByRole("button", { name: "Reset" }).click();
  await expect(page.getByRole("main")).toContainText("Quick edit check");
  await page.goto("/calendar?view=list");
  await expect(page.getByRole("main")).toContainText("Quick edit check");
});

test("quick edit is closed on a detail that has started, and bulk edit flags it", async ({ page, context }) => {
  const id = await makeJob("Started quick edit check", 0);
  // Started an hour ago, but never before agency midnight: the calendar list starts there, so an earlier start
  // would hide the detail in the first hour of the agency day.
  const now = Date.now();
  const today = agencyDateParts(new Date(now));
  const start = Math.max(now - 3_600_000, agencyInstant(today.year, today.month, today.day, 0, 0).getTime());
  await rows("update jobs set start_at = $2, end_at = $3 where id = $1", [id, new Date(start), new Date(now + 3 * 3_600_000)]);
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto(`/jobs/${id}?tab=manage`);
  await expect(page.getByTestId("quick-edit-closed")).toHaveText("This detail has started. Quick edit is for details that have not started.");
  await expect(page.getByRole("form", { name: "Quick edit" })).toHaveCount(0);
  await page.goto("/calendar?view=list&f=1&q=Started%20quick");
  await expect(page.getByRole("main")).toContainText("Not editable: This detail has started.");
  await expect(page.getByRole("checkbox", { name: /Started quick edit check/ })).toHaveCount(0);
  await shot(page, "started-flag-phone-day");
});

test("a time edit that double-books a deputy lists the conflict and saves only with a confirmed override", async ({ page, context }) => {
  const first = await makeJob("Conflict first", 9);
  const second = await makeJob("Conflict second", 9);
  // The second detail runs 21:30 to 23:30 the same evening; Riley holds a spot on both.
  await rows("update jobs set start_at = start_at + interval '4 hours 30 minutes', end_at = end_at + interval '2 hours 30 minutes' where id = $1", [second]);
  const riley = (await one<{ id: string }>("select id from users where email = $1", [COORD.signed.email])).id;
  for (const id of [first, second]) {
    const pos = await one<{ id: string }>("select id from job_positions where job_id = $1", [id]);
    await rows("insert into assignments (id, job_id, job_position_id, user_id, status) values (gen_random_uuid()::text, $1, $2, $3, 'signed_up')", [id, pos.id, riley]);
  }
  const secondNumber = (await one<{ number: number }>("select number from jobs where id = $1", [second])).number;
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto(`/jobs/${first}?tab=manage`);
  const form = page.getByRole("form", { name: "Quick edit" });
  await form.getByLabel("End time").fill("22:30");
  await form.getByRole("button", { name: "Save changes" }).click();
  const conflicts = page.getByTestId("quick-conflicts");
  await expect(conflicts).toContainText(`${COORD.signed.name} on #`);
  await expect(conflicts).toContainText(`Overlaps Detail #${secondNumber}`);
  expect((await one<{ end: string }>("select to_char(end_at at time zone 'America/Chicago', 'HH24:MI') as end from jobs where id = $1", [first])).end).toBe("21:00");
  // Changing the edit after confirming drops the override and hides the old list until the next save.
  await form.getByLabel("Save anyway: I confirm these deputies stay on with the conflicts above").check();
  await form.getByLabel("Reason for the override").fill("Stale reason");
  await form.getByLabel("End time").fill("23:00");
  await expect(conflicts).toHaveCount(0);
  await expect(form.getByRole("button", { name: "Save changes" })).toBeEnabled();
  await form.getByLabel("End time").fill("22:30");
  await form.getByRole("button", { name: "Save changes" }).click();
  await expect(conflicts).toContainText(`Overlaps Detail #${secondNumber}`);
  await form.getByLabel("Save anyway: I confirm these deputies stay on with the conflicts above").check();
  await expect(form.getByRole("button", { name: "Save changes" })).toBeDisabled();
  await form.getByLabel("Reason for the override").fill("Riley leaves early; second detail starts late");
  await shot(page, "conflict-override-phone-day");
  await expectNoSeriousA11yIssues(page);
  await noSideScroll(page);
  await form.getByRole("button", { name: "Save with override" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved." })).toBeVisible();
  expect((await one<{ end: string }>("select to_char(end_at at time zone 'America/Chicago', 'HH24:MI') as end from jobs where id = $1", [first])).end).toBe("22:30");
  const audit = await one<{ reason: string }>("select reason from audit_log where entity_id = $1 and action = 'job.schedule_conflict_override'", [first]);
  expect(audit.reason).toBe("Riley leaves early; second detail starts late");
});

test("Edit detail offers the same conflict override for a date move", async ({ page, context }) => {
  const first = await makeJob("Edit detail conflict first", 11);
  const second = await makeJob("Edit detail conflict second", 12);
  const riley = (await one<{ id: string }>("select id from users where email = $1", [COORD.signed.email])).id;
  for (const id of [first, second]) {
    const pos = await one<{ id: string }>("select id from job_positions where job_id = $1", [id]);
    await rows("insert into assignments (id, job_id, job_position_id, user_id, status) values (gen_random_uuid()::text, $1, $2, $3, 'signed_up')", [id, pos.id, riley]);
  }
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto(`/jobs/${first}?tab=manage`);
  await page.getByRole("button", { name: "Edit detail" }).click();
  const editor = page.getByRole("form", { name: "Edit detail" });
  await editor.getByLabel("Date").fill(dayKey(12));
  await editor.getByRole("button", { name: "Save changes" }).click();
  await expect(page.getByTestId("edit-conflicts")).toContainText("Overlaps Detail #");
  await editor.getByLabel("Save anyway: I confirm these deputies stay on with the conflicts above").check();
  await editor.getByLabel("Reason for the override").fill("Two halves of one event");
  await expectNoSeriousA11yIssues(page);
  await shot(page, "edit-detail-conflict-phone-day");
  await editor.getByRole("button", { name: "Save with override" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  const day = await one<{ day: string }>("select to_char(start_at at time zone 'America/Chicago', 'YYYY-MM-DD') as day from jobs where id = $1", [first]);
  expect(day.day).toBe(dayKey(12));
});

test("a bulk save refused after the preview drops the stale preview and asks for a new one", async ({ page, context }) => {
  const a = await makeJob("Stale preview first", 16);
  const b = await makeJob("Stale preview second", 17);
  const [na, nb] = await Promise.all([a, b].map(async (id) => (await one<{ number: number }>("select number from jobs where id = $1", [id])).number));
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/jobs?f=1&q=Stale%20preview");
  await page.getByRole("checkbox", { name: `Select #${na} Stale preview first` }).check();
  await page.getByRole("checkbox", { name: `Select #${nb} Stale preview second` }).check();
  await page.getByRole("button", { name: "Edit selected" }).click();
  const form = page.getByRole("form", { name: "Bulk edit" });
  await form.getByLabel("New end time").fill("23:00");
  await form.getByRole("button", { name: "Preview changes" }).click();
  await expect(page.getByRole("list", { name: "Before and after" })).toBeVisible();
  // Meanwhile Riley takes a spot on the first detail and on a detail right after it.
  const riley = (await one<{ id: string }>("select id from users where email = $1", [COORD.signed.email])).id;
  const late = await makeJob("Stale preview late shift", 16);
  await rows("update jobs set start_at = start_at + interval '4 hours 30 minutes', end_at = end_at + interval '3 hours' where id = $1", [late]);
  for (const id of [a, late]) {
    const pos = await one<{ id: string }>("select id from job_positions where job_id = $1", [id]);
    await rows("insert into assignments (id, job_id, job_position_id, user_id, status) values (gen_random_uuid()::text, $1, $2, $3, 'signed_up')", [id, pos.id, riley]);
  }
  await page.getByRole("button", { name: "Save all 2 details" }).click();
  await expect(page.getByTestId("bulk-stale")).toContainText("Nothing was saved");
  await expect(page.getByTestId("bulk-stale")).toContainText("Preview the changes again");
  await expect(page.getByRole("list", { name: "Before and after" })).toHaveCount(0);
  await form.getByRole("button", { name: "Preview changes" }).click();
  await expect(page.getByTestId("bulk-conflicts")).toContainText(`${COORD.signed.name} on #${na}`);
  await shot(page, "bulk-stale-phone-day");
  await expectNoSeriousA11yIssues(page);
});
