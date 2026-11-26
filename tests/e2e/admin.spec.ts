import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";
import { createServer, type Server, type Socket } from "node:net";
import { Client } from "pg";
import { ADMIN } from "./admin-fixtures";
import { E2E, E2E_USERS } from "./env";
import { signInAs } from "./session";
import { decryptSecret } from "@/lib/crypto/secrets";

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
const userId = async (email: string) => (await one<{ id: string }>("select id from users where email = $1", [email])).id;
const flagId = async (name: string) => (await one<{ id: string }>("select id from qualifications where name = $1", [name])).id;

type Screen = { name: string; path: () => Promise<string>; heading: string; who?: "coordinator" | "admin" };

// Every path is a promise, since some screens look up a record id first; `at` gives a fixed path in that shape.
const at = (path: string) => () => Promise.resolve(path);
const SCREENS: Screen[] = [
  { name: "management", path: at("/admin"), heading: "Management" },
  { name: "users", path: at("/admin/users"), heading: "Users" },
  { name: "user", path: async () => `/admin/users/${await userId(ADMIN.holder.email)}`, heading: ADMIN.holder.name },
  { name: "ranks", path: at("/admin/ranks"), heading: "Ranks" },
  { name: "flags", path: at("/admin/flags"), heading: "Special flags" },
  { name: "flag", path: async () => `/admin/flags/${await flagId(ADMIN.heldFlag)}`, heading: ADMIN.heldFlag },
  { name: "seasons", path: at("/admin/seasons"), heading: "Seasons and caps" },
  { name: "release", path: at("/admin/settings/release"), heading: "Release" },
  { name: "signup", path: at("/admin/settings/signup"), heading: "Sign-up" },
  { name: "billing", path: at("/admin/settings/billing"), heading: "Billing and invoices" },
  { name: "reminders", path: at("/admin/settings/reminders"), heading: "Reminders and locks" },
  { name: "vendor-limits", path: at("/admin/settings/vendors"), heading: "Vendor limits" },
  { name: "ops-review", path: at("/admin/settings/ops-plans"), heading: "Ops plan review" },
  { name: "map", path: at("/admin/settings/map"), heading: "Map" },
  { name: "notifications", path: at("/admin/settings/notifications"), heading: "Notifications" },
  { name: "positions", path: at("/admin/positions"), heading: "Position types" },
  { name: "job-types", path: at("/admin/lists/job-types"), heading: "Job types" },
  { name: "note-presets", path: at("/admin/note-presets"), heading: "Note presets" },
  { name: "agency", path: at("/admin/agency"), heading: "Agency profile" },
  { name: "access-review", path: at("/admin/access-review"), heading: "Access review" },
  { name: "audit", path: at("/admin/audit"), heading: "Audit log" },
  { name: "system", path: at("/admin/system"), heading: "System", who: "admin" },
  { name: "email", path: at("/admin/system/email"), heading: "Email", who: "admin" },
  { name: "security", path: at("/admin/system/security"), heading: "Security", who: "admin" },
  { name: "api", path: at("/admin/api"), heading: "API access", who: "admin" },
];

for (const theme of THEMES) {
  test.describe(`management screens, ${theme.name}`, () => {
    test.use({ colorScheme: theme.colorScheme });
    for (const screen of SCREENS) {
      test(`${screen.name} at phone and desktop sizes`, async ({ page, context }) => {
        await signInAs(context, screen.who ?? "coordinator");
        const path = await screen.path();
        for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
          await page.setViewportSize(viewport);
          await page.goto(path);
          await expect(page.getByRole("heading", { level: 1, name: screen.heading, exact: true })).toBeVisible();
          const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          expect(overflow, "no sideways page scroll").toBeLessThanOrEqual(0);
          await page.screenshot({ path: `${E2E.screenshotDir}/admin-${screen.name}-${size}-${theme.name}.png`, fullPage: true });
          await expectNoSeriousA11yIssues(page);
        }
      });
    }
  });
}

test("every response forbids framing and sniffing: pages, the sign-in screen and the API", async ({ request }) => {
  for (const path of ["/sign-in", "/admin", "/api/health"]) {
    const res = await request.get(path, { maxRedirects: 0 });
    const h = res.headers();
    expect(h["content-security-policy"], path).toBe("frame-ancestors 'none'");
    expect(h["x-frame-options"], path).toBe("DENY");
    expect(h["x-content-type-options"], path).toBe("nosniff");
    expect(h["referrer-policy"], path).toBe("same-origin");
    // HSTS belongs to Caddy's HTTPS site, never the app.
    expect(h["strict-transport-security"], path).toBeUndefined();
  }
});

test("a coordinator invites a user", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/admin/users");
  await page.getByRole("button", { name: "Invite user" }).click();
  await page.getByLabel("Name", { exact: true }).fill("Jordan Invited");
  await page.getByLabel("Email", { exact: true }).fill("jordan.invited@e2e.test");
  // Coordinators cannot create admin accounts, so the choice is not offered.
  await expect(page.getByLabel("Role").locator("option", { hasText: "Admin" })).toHaveCount(0);
  await page.getByLabel("Role").selectOption({ label: "Personnel" });
  await page.getByLabel("Rank").selectOption({ label: "CSO" });
  await page.getByRole("checkbox", { name: "School Resource Deputy" }).check();
  await page.getByRole("button", { name: "Send invite" }).click();
  await expect(page.getByRole("status")).toContainText("Invite sent to jordan.invited@e2e.test.");
  await expect(page.getByRole("link", { name: "Jordan Invited" })).toBeVisible();
  const u = await one<{ id: string; role: string }>("select id, role from users where email = 'jordan.invited@e2e.test'");
  expect(u.role).toBe("personnel");
  expect(await rows("select id from invites where user_id = $1", [u.id])).toHaveLength(1);
  expect(await rows("select q.name from user_qualifications uq join qualifications q on q.id = uq.qualification_id where uq.user_id = $1", [u.id])).toEqual([{ name: "School Resource Deputy" }]);
});

test("a coordinator suspends a user with an end date, then lifts it", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  const id = await userId(ADMIN.suspend.email);
  await page.goto(`/admin/users/${id}`);
  const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
  await page.getByRole("button", { name: "Suspend user" }).click();
  await page.getByLabel("Reason").fill("Missed two details without notice.");
  await page.getByLabel("Suspended until").fill(until);
  await page.getByRole("button", { name: "Confirm suspension" }).click();
  await expect(page.getByRole("status")).toContainText("Suspended.");
  const row = await one<{ suspension_reason: string; until: string }>(
    "select suspension_reason, to_char(suspended_until at time zone 'America/Chicago', 'YYYY-MM-DD HH24:MI') as until from users where id = $1",
    [id],
  );
  expect(row).toEqual({ suspension_reason: "Missed two details without notice.", until: `${until} 00:00` });
  await expect(page.getByText("Missed two details without notice.")).toBeVisible();
  await page.goto("/admin/users?show=suspended");
  await expect(page.getByRole("link", { name: ADMIN.suspend.name })).toBeVisible();
  await page.goto(`/admin/users/${id}`);
  await page.getByRole("button", { name: "Lift suspension" }).click();
  await expect(page.getByRole("status")).toContainText("Suspension lifted.");
  expect((await one<{ r: string | null }>("select suspension_reason as r from users where id = $1", [id])).r).toBeNull();
});

test("changing the release day moves a scheduled detail's release date", async ({ page, context }) => {
  // Other suites depend on their own release dates, so they are put back afterwards.
  const saved = await rows<{ id: string; release_at: Date | null }>("select id, release_at from jobs");
  const settingsBefore = await rows<{ id: string; value: unknown }>("select id, value from settings");
  try {
    await signInAs(context, "coordinator");
    await page.setViewportSize(DESKTOP);
    const job = await one<{ id: string }>("select id from jobs where title = $1", [ADMIN.releaseJob]);
    await page.goto(`/coordinate/details/${job.id}`);
    await expect(page.getByTestId("release-state")).toHaveText(/Opens \w+ 15, \d{4} at 4:00 PM/);

    await page.goto("/admin/settings/release");
    await page.getByLabel("Release day of month").fill("40");
    await page.getByRole("button", { name: "Save release settings" }).click();
    await expect(page.getByText("Enter 31 or less.")).toBeVisible();
    await expect(page.getByLabel("Release day of month")).toHaveAttribute("aria-invalid", "true");

    await page.getByLabel("Release day of month").fill("20");
    await page.getByRole("button", { name: "Save release settings" }).click();
    await expect(page.getByRole("status")).toContainText(/Saved\. \d+ details? now opens? on the new release date\./);
    await page.goto(`/coordinate/details/${job.id}`);
    await expect(page.getByTestId("release-state")).toHaveText(/Opens \w+ 20, \d{4} at 4:00 PM/);
  } finally {
    for (const s of saved) await rows("update jobs set release_at = $2 where id = $1", [s.id, s.release_at]);
    await rows("delete from settings");
    for (const s of settingsBefore) await rows("insert into settings (id, value) values ($1, $2)", [s.id, JSON.stringify(s.value)]);
  }
});

test("a coordinator edits the All year season's week cap", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(PHONE);
  await page.goto("/admin/seasons");
  const season = page.getByRole("region", { name: "All year" });
  await season.getByRole("button", { name: "Edit season" }).click();
  await season.getByLabel("Week cap (hours)").fill("44");
  await season.getByRole("button", { name: "Save season" }).click();
  await expect(page.getByRole("status")).toContainText("Season saved.");
  expect((await one<{ m: number }>("select week_cap_minutes as m from seasons where name = 'All year'")).m).toBe(44 * 60);
  await expect(season.getByText("44 h")).toBeVisible();
});

test("special flags: approve a request, grant and revoke", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/admin/flags");
  const request = page.getByRole("listitem").filter({ hasText: ADMIN.flagged.name });
  await expect(request).toContainText("Handler course finished in September.");
  await request.getByRole("button", { name: "Approve" }).click();
  await expect(page.getByRole("status")).toContainText("Approved.");

  await page.goto(`/admin/flags/${await flagId(ADMIN.requestedFlag)}`);
  await expect(page.getByRole("listitem").filter({ hasText: ADMIN.flagged.name })).toBeVisible();
  await page.getByLabel("Person").selectOption({ label: ADMIN.reviewee.name });
  await page.getByRole("button", { name: "Grant flag" }).click();
  await expect(page.getByRole("status")).toContainText(`${ADMIN.requestedFlag} granted to ${ADMIN.reviewee.name}.`);
  const holder = page.getByRole("listitem").filter({ hasText: ADMIN.reviewee.name });
  await holder.getByRole("button", { name: "Revoke" }).click();
  await expect(page.getByRole("status")).toContainText("Revoked.");
  await expect(holder).toHaveCount(0);
});

test("a coordinator cannot change an admin account", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto(`/admin/users/${await userId(E2E_USERS.admin.email)}`);
  await expect(page.getByText("Only admins can change admin accounts.")).toBeVisible();
  for (const name of ["Edit account", "Suspend user", "Deactivate user", "Resend invite", "Send invite", "Revoke", "Grant flag"]) {
    await expect(page.getByRole("button", { name })).toHaveCount(0);
  }
});

test("a coordinator adds a position type vendors can request", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/admin/positions");
  await page.getByRole("button", { name: "Add position type" }).click();
  const form = page.getByRole("form", { name: "Add position type" });
  await form.getByLabel("Name").fill("Traffic Lead");
  await form.getByRole("checkbox", { name: "Deputy Sheriff" }).check();
  await form.getByRole("checkbox", { name: "Motors" }).check();
  await form.getByRole("checkbox", { name: "Vendors can request it" }).check();
  await form.getByRole("button", { name: "Add position type" }).click();
  await expect(page.getByRole("status")).toContainText("Position type added.");
  const row = await one<{ vendor_requestable: boolean; n: number }>(
    "select vendor_requestable, cardinality(required_qualification_ids) as n from position_types where name = 'Traffic Lead'",
  );
  expect(row).toEqual({ vendor_requestable: true, n: 1 });
});

test("the agency logo takes a PNG or an SVG and is served for display", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/admin/agency");
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="30" fill="#123c8c"/></svg>';
  await page.getByLabel("Logo file").setInputFiles({ name: "star.svg", mimeType: "image/svg+xml", buffer: Buffer.from(svg) });
  await page.getByRole("button", { name: "Upload logo" }).click();
  await expect(page.getByRole("status")).toContainText("Logo saved.");
  await expect(page.getByRole("img", { name: "Agency logo" })).toBeVisible();
  const res = await page.request.get("/api/v1/agency/logo");
  expect(res.status()).toBe(200);
  expect(res.headers()["content-type"]).toBe("image/png");
  await page.getByLabel("Logo file").setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByRole("button", { name: "Upload logo" }).click();
  await expect(page.getByRole("status")).toContainText("Upload a PNG, SVG, JPG or WebP file.");
});

test("an access review starts, takes decisions and reports them", async ({ page, context }) => {
  try {
    await signInAs(context, "coordinator");
    await page.setViewportSize(DESKTOP);
    await page.goto("/admin/access-review");
    await page.getByRole("button", { name: "Start access review" }).click();
    await expect(page.getByRole("status")).toContainText("Access review started.");
    const item = page.getByRole("listitem").filter({ hasText: ADMIN.reviewee.name });
    await item.getByRole("button", { name: "Keep" }).click();
    await expect(page.getByRole("status")).toContainText("Recorded.");
    await page.getByRole("link", { name: "Report", exact: true }).click();
    await expect(page.getByRole("heading", { level: 1, name: "Access review report" })).toBeVisible();
    await expect(page.getByRole("row").filter({ hasText: ADMIN.reviewee.name })).toContainText("Keep");
  } finally {
    await rows("update access_reviews set completed_at = now() where completed_at is null");
  }
});

test("the audit log filters by record type", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/admin/audit");
  await page.getByLabel("Record type").selectOption("season");
  await page.getByRole("button", { name: "Filter" }).click();
  await expect(page).toHaveURL(/type=season/);
  const table = page.getByRole("table");
  await expect(table.getByRole("row").nth(1)).toContainText("season.update");
  for (const cell of await table.locator("tbody tr td:nth-child(4)").allInnerTexts()) expect(cell).toMatch(/^season/);
});

/** A tiny SMTP server that keeps every message it receives. */
function smtpCapture(): Promise<{ server: Server; port: number; messages: string[] }> {
  const messages: string[] = [];
  const server = createServer((socket: Socket) => {
    let data = false;
    let buf = "";
    socket.write("220 capture ESMTP\r\n");
    socket.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      for (;;) {
        if (data) {
          const end = buf.indexOf("\r\n.\r\n");
          if (end === -1) return;
          messages.push(buf.slice(0, end));
          buf = buf.slice(end + 5);
          data = false;
          socket.write("250 OK queued\r\n");
          continue;
        }
        const nl = buf.indexOf("\r\n");
        if (nl === -1) return;
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 2);
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === "EHLO" || cmd === "HELO") socket.write("250 capture\r\n");
        else if (cmd === "DATA") {
          data = true;
          socket.write("354 End with .\r\n");
        } else if (cmd === "QUIT") socket.end("221 Bye\r\n");
        else socket.write("250 OK\r\n");
      }
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, port: (server.address() as { port: number }).port, messages })));
}

test("an admin's SMTP test email reaches the server, and the password stays write-only", async ({ page, context }) => {
  const smtp = await smtpCapture();
  try {
    await signInAs(context, "admin");
    await page.setViewportSize(DESKTOP);
    await page.goto("/admin/system/email");
    await page.getByLabel("Provider").selectOption({ label: "SMTP server" });
    await page.getByLabel("From address").fill("Extra Duty <noreply@e2e.test>");
    await page.getByLabel("Host").fill("127.0.0.1");
    await page.getByLabel("Port").fill(String(smtp.port));
    await page.getByLabel("Username").fill("mailer");
    await page.getByLabel("Password", { exact: true }).fill("s3cret-smtp-pass");
    await page.getByRole("button", { name: "Save email settings" }).click();
    await expect(page.getByRole("status")).toContainText("Email settings saved.");
    await page.reload();
    await expect(page.getByText("Password is set. Leave blank to keep it.")).toBeVisible();
    await expect(page.getByLabel("Password", { exact: true })).toHaveValue("");
    expect(await page.content()).not.toContain("s3cret-smtp-pass");

    // The capture server offers no AUTH, so the test message goes out without credentials.
    await page.getByRole("checkbox", { name: "Remove the saved password" }).check();
    await page.getByLabel("Username").fill("");
    await page.getByRole("button", { name: "Save email settings" }).click();
    await expect(page.getByRole("status")).toContainText("Email settings saved.");

    await page.getByRole("button", { name: "Send test email" }).click();
    await expect(page.getByRole("status")).toContainText(`Test email sent to ${E2E_USERS.admin.email}.`);
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain(`To: ${E2E_USERS.admin.email}`);
    expect(smtp.messages[0]).toContain("Subject: Extra Duty test email");
  } finally {
    smtp.server.close();
  }
});

const SYSTEM_URLS = ["/admin/system", "/admin/system/email", "/admin/system/security", "/admin/api"];

test("coordinators get 403 on every System URL", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  for (const url of SYSTEM_URLS) {
    const res = await page.goto(url);
    expect(res?.status(), url).toBe(403);
    await expect(page.getByRole("heading", { level: 1, name: "Admins only" })).toBeVisible();
  }
  // The Management page does not offer System to coordinators.
  await page.goto("/admin");
  await expect(page.getByRole("link", { name: /^Email/ })).toHaveCount(0);
});

test("System server actions answer 403 to a coordinator", async ({ page, context }) => {
  await signInAs(context, "admin");
  await page.setViewportSize(DESKTOP);
  for (const [url, button] of [
    ["/admin/system/security", "Save security settings"],
    ["/admin/system/email", "Send test email"],
  ] as const) {
    await page.goto(url);
    // The page was opened by an admin; the session is now a coordinator's.
    await context.clearCookies();
    await signInAs(context, "coordinator");
    const before = await rows("select value from settings");
    const response = page.waitForResponse((r) => r.request().method() === "POST" && r.url().includes(url));
    if (url.endsWith("security")) await page.getByLabel("Sign-in code lifetime (minutes)").fill("20");
    await page.getByRole("button", { name: button }).click();
    expect((await response).status(), url).toBe(403);
    await expect(page.getByRole("status")).toContainText("Only admins can do that.");
    expect(await rows("select value from settings")).toEqual(before);
    await context.clearCookies();
    await signInAs(context, "admin");
  }
});

test("an admin saves security settings", async ({ page, context }) => {
  await signInAs(context, "admin");
  await page.setViewportSize(PHONE);
  await page.goto("/admin/system/security");
  await page.getByLabel("Minimum password length").fill("6");
  await page.getByRole("button", { name: "Save security settings" }).click();
  await expect(page.getByText("Enter 8 or more.")).toBeVisible();
  await page.getByLabel("Minimum password length").fill("14");
  await page.getByRole("button", { name: "Save security settings" }).click();
  await expect(page.getByRole("status")).toContainText("Security settings saved.");
  expect((await one<{ n: number }>("select (value->'security'->>'passwordMinLength')::int as n from settings")).n).toBe(14);
  await page.getByLabel("Minimum password length").fill("12");
  await page.getByRole("button", { name: "Save security settings" }).click();
  await expect(page.getByRole("status")).toContainText("Security settings saved.");
});

test("a coordinator sets the agency rate range, and one detail outside it needs an approved reason", async ({ page, context }) => {
  const job = await one<{ id: string; rate_cents: number }>("select id, rate_cents from jobs where title = $1", [ADMIN.releaseJob]);
  const settingsBefore = await rows<{ id: string; value: unknown }>("select id, value from settings");
  try {
    await signInAs(context, "coordinator");
    await page.setViewportSize(DESKTOP);
    await page.goto("/admin/settings/billing");
    await page.getByLabel("Lowest rate allowed per hour").fill("50");
    await page.getByLabel("Highest rate allowed per hour").fill("40");
    await page.getByRole("button", { name: "Save billing settings" }).click();
    await expect(page.getByText("The maximum must be at least the minimum.")).toBeVisible();
    await expect(page.getByLabel("Highest rate allowed per hour")).toHaveAttribute("aria-invalid", "true");
    await page.getByLabel("Highest rate allowed per hour").fill("90");
    await page.getByRole("button", { name: "Save billing settings" }).click();
    await expect(page.getByRole("status")).toContainText("Billing settings saved.");

    await page.goto(`/coordinate/details/${job.id}`);
    await page.getByRole("button", { name: "Edit detail" }).click();
    const editor = page.getByRole("form", { name: "Edit detail" });
    await editor.getByLabel("Rate per hour").fill("95");
    await expect(editor.getByText("Rate outside the agency range.")).toBeVisible();
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByRole("status")).toContainText("Rate must be between $50 and $90 an hour.");
    await editor.getByLabel("Reason for the exception").fill("Market night premium agreed in writing");
    await editor.getByRole("button", { name: "Save changes" }).click();
    await expect(page.getByText(/Rate approved outside the agency range by Quinn Okafor, \w+ \d+, \d{4}: Market night premium agreed in writing/)).toBeVisible();
    await expectNoSeriousA11yIssues(page);
  } finally {
    await rows("update jobs set rate_cents = $2, rate_override_reason = null, rate_override_by = null, rate_override_at = null where id = $1", [job.id, job.rate_cents]);
    await rows("delete from settings");
    for (const s of settingsBefore) await rows("insert into settings (id, value) values ($1, $2)", [s.id, JSON.stringify(s.value)]);
  }
});

test("phone fields format while typing and save as ###-###-####", async ({ page, context }) => {
  const before = await rows<{ id: string; value: unknown }>("select id, value from settings");
  try {
    await signInAs(context, "coordinator");
    await page.setViewportSize(PHONE);
    await page.goto("/admin/agency");
    const phone = page.getByLabel("Phone", { exact: true });
    await phone.fill("");
    await phone.pressSequentially("8505550148");
    await expect(phone).toHaveValue("850-555-0148");
    await phone.press("Backspace");
    await expect(phone).toHaveValue("850-555-014");
    await phone.fill("");
    await phone.pressSequentially("85055");
    await expect(phone).toHaveValue("850-55");
    await page.getByRole("button", { name: "Save agency profile" }).click();
    await expect(page.getByText("Enter a 10-digit phone number.")).toBeVisible();
    await phone.fill("+1 (850) 555-0148");
    await expect(phone).toHaveValue("850-555-0148");
    await page.getByRole("button", { name: "Save agency profile" }).click();
    await expect(page.getByRole("status")).toContainText("Agency profile saved.");
    expect((await one<{ p: string }>("select value->'agency'->>'phone' as p from settings")).p).toBe("850-555-0148");
  } finally {
    await rows("delete from settings");
    for (const s of before) await rows("insert into settings (id, value) values ($1, $2)", [s.id, JSON.stringify(s.value)]);
  }
});

test("the vendor record lists contact details one per line with links", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  const v = await one<{ id: string }>("select id from vendors where name = $1", [ADMIN.vendor]);
  for (const [size, viewport] of [["phone", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(viewport);
    await page.goto(`/coordinate/vendors/${v.id}`);
    const list = page.locator("dl").first();
    await expect(list.locator("dt")).toHaveText(["Contact", "Phone", "Billing emails", "Default rate"]);
    await expect(list.getByRole("link", { name: "850-555-0148" })).toHaveAttribute("href", "tel:+18505550148");
    await expect(list.getByRole("link", { name: "office@market.example" })).toHaveAttribute("href", "mailto:office@market.example");
    await expect(list.getByRole("link", { name: "books@market.example" })).toBeVisible();
    await expect(list.getByText("$65/hr")).toBeVisible();
    await page.screenshot({ path: `${E2E.screenshotDir}/admin-vendor-record-${size}.png`, fullPage: true });
    await expectNoSeriousA11yIssues(page);
  }
});

test("an admin makes an API key, sees it once, uses it and revokes it", async ({ page, context }) => {
  await signInAs(context, "admin");
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.setViewportSize(DESKTOP);
  await page.goto("/admin/api");
  await page.getByLabel("Name", { exact: true }).fill("E2E payroll export");
  await page.getByRole("radio", { name: /Read only/ }).check();
  await page.getByRole("button", { name: "Make key" }).click();
  await expect(page.getByRole("heading", { name: "Copy your new key" })).toBeVisible();
  await expect(page.getByText("You will not see this key again.")).toBeVisible();
  const key = await page.getByLabel("New API key").inputValue();
  expect(key).toMatch(/^ed_live_/);
  await page.getByRole("button", { name: "Copy key" }).click();
  await expect(page.getByRole("button", { name: "Copied" })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(key);
  const stored = await one<{ hashed_key: string; prefix: string }>("select hashed_key, prefix from api_keys where name = 'E2E payroll export'");
  expect(stored.hashed_key).not.toContain(key.slice(8));
  expect(key.startsWith(stored.prefix)).toBe(true);

  const api = await page.request.get("/api/v1/data/vendors", { headers: { authorization: `Bearer ${key}` } });
  expect(api.status()).toBe(200);
  await page.getByRole("button", { name: "I stored the key" }).click();
  await expect(page.getByLabel("New API key")).toHaveCount(0);
  await page.reload();
  await expect(page.getByText(stored.prefix)).toBeVisible();
  await expect(page.getByText(key)).toHaveCount(0);
  await expect(page.getByText(/Last used/)).toBeVisible();

  await page.getByRole("button", { name: "Revoke E2E payroll export" }).click();
  await page.getByRole("button", { name: "Revoke E2E payroll export" }).click();
  await expect(page.getByRole("status")).toContainText("E2E payroll export revoked.");
  await expect(page.getByText(/^Revoked /)).toBeVisible();
  expect((await page.request.get("/api/v1/data/vendors", { headers: { authorization: `Bearer ${key}` } })).status()).toBe(401);

  await page.locator("summary", { hasText: /^Jobs/ }).click();
  await expect(page.getByText("/api/v1/jobs/{id}/attachments", { exact: true })).toBeVisible();
});

test("deactivating an admin with active API keys warns that the keys stop working and needs a confirmation", async ({ page, context }) => {
  const [keyAdmin] = await rows<{ id: string }>(
    "insert into users (id, name, email, email_verified, role) values (gen_random_uuid()::text, 'Morgan Keys', 'morgan.keys@e2e.test', true, 'admin') returning id",
  );
  const key = (name: string, prefix: string, revoked: boolean) =>
    rows("insert into api_keys (id, name, hashed_key, prefix, scopes, created_by, revoked_at) values (gen_random_uuid()::text, $1, $2, $3, '{read}', $4, $5)", [name, `hash-${prefix}`, prefix, keyAdmin.id, revoked ? new Date() : null]);
  await key("Payroll sync", "ed_live_Pay123", false);
  await key("Old export", "ed_live_Old456", true);

  await signInAs(context, "admin");
  await page.setViewportSize(PHONE);
  await page.goto(`/admin/users/${keyAdmin.id}`);
  await page.getByRole("button", { name: "Deactivate user" }).click();
  await page.getByLabel("Reason").fill("Retired");
  await page.getByRole("button", { name: "Review checklist" }).click();
  const warning = page.getByRole("group", { name: "Checklist for Morgan Keys" });
  await expect(warning).toContainText("1 active API key will stop working");
  await expect(warning.getByRole("listitem")).toHaveText(["Payroll sync ed_live_Pay123"]);
  await expect(warning).not.toContainText("Old export");
  const turnOff = warning.getByRole("button", { name: "Turn off account" });
  await expect(turnOff).toBeDisabled();
  await expectNoSeriousA11yIssues(page);
  await warning.getByRole("checkbox", { name: "I understand these keys will stop working" }).check();
  await turnOff.click();
  await expect(page.getByRole("status").filter({ hasText: "Account turned off." })).toBeVisible();
  expect((await one<{ active: boolean }>("select active from users where id = $1", [keyAdmin.id])).active).toBe(false);
});

test("a deputy leaves: the checklist, the spots reopen, the unbilled detail stays on the to-do list, then reactivation", async ({ page, context }) => {
  const id = await userId(ADMIN.leaver.email);
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto(`/admin/users/${id}`);
  await page.getByRole("button", { name: "Deactivate user" }).click();
  await page.getByLabel("Reason").fill("Moved out of state");
  await page.getByRole("button", { name: "Review checklist" }).click();

  const checklist = page.getByRole("group", { name: `Checklist for ${ADMIN.leaver.name}` });
  await expect(checklist.getByRole("region", { name: "Upcoming sign-ups" }).getByRole("listitem")).toHaveCount(2);
  await expect(checklist.getByRole("region", { name: "Past details not billed" }).getByRole("listitem")).toHaveCount(1);
  await expect(checklist.getByRole("region", { name: "Unpaid invoices" })).toContainText("None.");
  await expectNoSeriousA11yIssues(page);
  // Nothing has changed yet.
  expect((await one<{ active: boolean }>("select active from users where id = $1", [id])).active).toBe(true);

  await checklist.getByRole("button", { name: "Turn off account" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Account turned off." })).toContainText("2 sign-ups removed.");
  await expect(page.getByText("Moved out of state. Last day")).toBeVisible();
  await expect(page.getByRole("region", { name: "Not billed yet" }).getByRole("listitem")).toContainText("Bill for them");

  // The two spots reopen: nobody holds them, and staff read Left the agency in the detail's history.
  const upcoming = await rows<{ status: string; open: number }>(
    "select a.status, (select count(*)::int from assignments x where x.job_id = j.id and x.status = 'signed_up') as open from assignments a join jobs j on j.id = a.job_id where a.user_id = $1 and j.title = any($2) order by j.start_at",
    [id, ADMIN.leaverJobs],
  );
  expect(upcoming).toEqual([{ status: "removed", open: 0 }, { status: "removed", open: 0 }]);
  const firstJob = (await one<{ id: string }>("select id from jobs where title = $1", [ADMIN.leaverJobs[0]])).id;
  await page.goto(`/coordinate/details/${firstJob}`);
  await expect(page.getByRole("listitem").filter({ hasText: ADMIN.leaver.name }).first()).toContainText("Left the agency");

  await page.goto("/coordinate");
  await expect(page.getByRole("region", { name: "Left the agency: not billed" })).toContainText(ADMIN.leaver.name);

  // The coordinator bills the worked detail on their behalf, through the usual billing screen.
  await page.getByRole("region", { name: "Left the agency: not billed" }).getByRole("link", { name: "Bill for them" }).click();
  await expect(page.getByRole("heading", { level: 1, name: `Bill for ${ADMIN.leaver.name}` })).toBeVisible();
  await page.getByRole("button", { name: /^(Send invoice|Submit for review)$/ }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Invoice/ })).toBeVisible();
  await expect(page.getByRole("link", { name: `Back to ${ADMIN.leaver.name}` }).first()).toBeVisible();
  const billed = await one<{ status: string; payee: string }>(
    "select a.status, i.payee_user_id as payee from assignments a join jobs j on j.id = a.job_id join invoices i on i.assignment_id = a.id where j.title = $1",
    [ADMIN.leaverWorked],
  );
  expect(billed).toEqual({ status: "billed", payee: id });
  await page.goto("/coordinate");
  await expect(page.getByRole("region", { name: "Left the agency: not billed" })).toHaveCount(0);

  await page.goto(`/admin/users/${id}`);
  await page.getByRole("button", { name: "Reactivate" }).click();
  await page.getByLabel("Reason").fill("Came back after the move fell through");
  await page.getByRole("button", { name: "Reactivate account" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Account turned back on." })).toBeVisible();
  expect((await one<{ active: boolean }>("select active from users where id = $1", [id])).active).toBe(true);
  // Old sign-ups are not restored.
  expect((await rows<{ status: string }>("select a.status from assignments a join jobs j on j.id = a.job_id where a.user_id = $1 and j.title = any($2)", [id, ADMIN.leaverJobs])).map((r) => r.status)).toEqual(["removed", "removed"]);
});

test("vendor email off for Detail canceled: staff cancel the vendor's detail, the vendor gets an inbox entry and no email", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/admin/settings/notifications");
  // Locked types show why and offer no switch.
  const signIn = page.getByRole("row", { name: /^Sign-in code/ });
  await expect(signIn).toContainText("Locked on. Needed to sign in.");
  await expect(signIn.getByRole("switch")).toHaveCount(0);
  const vendorEmail = page.getByRole("switch", { name: "Email to vendors: Detail canceled" });
  await expect(vendorEmail).toHaveAttribute("aria-checked", "true");
  await vendorEmail.click();
  await expect(page.getByRole("status").filter({ hasText: "Email to vendors for Detail canceled turned off." })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("switch", { name: "Email to vendors: Detail canceled" })).toHaveAttribute("aria-checked", "false");
  await expect(page.getByRole("switch", { name: "Email to deputies and personnel: Detail canceled" })).toHaveAttribute("aria-checked", "true");
  await page.screenshot({ path: `${E2E.screenshotDir}/admin-notifications-switched-desktop.png`, fullPage: true });

  // A coordinator cancels the vendor's detail.
  const job = await one<{ id: string; number: number }>("select id, number from jobs where title = $1", [ADMIN.notifyJob]);
  await page.goto(`/coordinate/details/${job.id}`);
  await page.getByRole("button", { name: "Cancel detail" }).click();
  await page.getByLabel("Reason", { exact: true }).fill("Lot closed for paving");
  await page.getByRole("button", { name: "Cancel detail" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Detail canceled." })).toBeVisible();

  const vendorUser = await userId(ADMIN.notifyLogin.email);
  const inbox = await rows<{ type: string; body: string }>("select type, body from notifications where user_id = $1", [vendorUser]);
  expect(inbox.map((r) => r.type)).toEqual(["job.canceled"]);
  expect(inbox[0].body).toMatch(new RegExp(`^Detail #${job.number} on .+ was canceled\\.$`));
  expect(inbox[0].body).not.toContain("paving");
  process.env.SECRETS_KEY = E2E.appEnv.SECRETS_KEY;
  const queued = await rows<{ data: { enc: string } }>("select data from pgboss.job where name = 'notify.email'");
  const to = queued.map((j) => (JSON.parse(decryptSecret(j.data.enc)) as { userId: string }).userId);
  expect(to).not.toContain(vendorUser);

  // Back on, for later runs against the same database.
  await page.goto("/admin/settings/notifications");
  await page.getByRole("switch", { name: "Email to vendors: Detail canceled" }).click();
  await expect(page.getByRole("status").filter({ hasText: "turned on" })).toBeVisible();
});
