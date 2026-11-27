import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import type { Locator, Page } from "@playwright/test";
import type { ManualId } from "../../src/domain/manuals/manuals";
import { PRACTICE_USER_EMAILS, type PracticeRole } from "../../src/domain/training/mode";
import { demoPassword } from "../demo-password";
import type { Size, Source } from "./browser";

export type ShotCtx = {
  size: Size;
  source: Source;
  /** Staging only: a query on the staging database, to find a detail in a given state. */
  query?: <T extends Record<string, unknown>>(sql: string, params?: unknown[]) => Promise<T[]>;
};

/** One numbered screenshot of a manual chapter: `go` opens the page and sets it up; `target` crops to one part. */
export type Shot = {
  manual: ManualId;
  /** The chapter file's name without .md, such as "05-signing-up". */
  chapter: string;
  step: number;
  role: PracticeRole | "signed-out";
  sizes: Size[];
  go: (page: Page, ctx: ShotCtx) => Promise<void>;
  target?: (page: Page, size: Size) => Locator;
  fullPage?: boolean;
  /** A context of its own (the shot changes or needs a clean session). */
  fresh?: boolean;
  /** Needs staging (signs in for real, switches to training, or looks a detail up in the database). */
  stagingOnly?: boolean;
};

const B: Size[] = ["phone", "desktop"];
const P: Size[] = ["phone"];
const D: Size[] = ["desktop"];

type Opts = Partial<Pick<Shot, "target" | "fullPage" | "fresh" | "stagingOnly">>;
const shots: Shot[] = [];
function add(manual: ManualId, role: Shot["role"], chapter: string, step: number, sizes: Size[], go: Shot["go"], opts: Opts = {}) {
  shots.push({ manual, role, chapter, step, sizes, go, ...opts });
}
const deputy = (chapter: string, step: number, sizes: Size[], go: Shot["go"], opts?: Opts) => add("deputy", "deputy", chapter, step, sizes, go, opts);
const vendor = (chapter: string, step: number, sizes: Size[], go: Shot["go"], opts?: Opts) => add("vendor", "vendor", chapter, step, sizes, go, opts);
const coord = (chapter: string, step: number, sizes: Size[], go: Shot["go"], opts?: Opts) => add("coordinator-admin", "coordinator", chapter, step, sizes, go, opts);
const admin = (chapter: string, step: number, sizes: Size[], go: Shot["go"], opts?: Opts) => add("coordinator-admin", "admin", chapter, step, sizes, go, opts);

// Page helpers.
const visit = (path: string) => async (page: Page) => {
  await page.goto(path);
};
const main = (page: Page) => page.getByRole("main");
/** The card (or other rounded panel) that holds the heading `name`. */
const card = (name: string | RegExp) => (page: Page) =>
  main(page)
    .getByRole("heading", { name, exact: typeof name === "string" ? true : undefined })
    .first()
    .locator("xpath=ancestor::*[contains(concat(' ', normalize-space(@class), ' '), ' rounded-xl ') or self::section or self::article][1]");
const region = (name: string | RegExp) => (page: Page) => main(page).getByRole("region", { name }).first();
const top = async (locator: Locator) => {
  await locator.first().scrollIntoViewIfNeeded();
  await locator.first().evaluate((el) => el.scrollIntoView({ block: "start" }));
};
/** Waits for an address lookup to answer: its status names the search and no longer says it is looking. */
async function lookupDone(page: Page): Promise<void> {
  await main(page).getByText("Address search by").first().waitFor();
  await main(page).getByText("Looking up the address.").waitFor({ state: "hidden" });
}
/** Opens the first link under main whose href starts with `prefix`, on `list`. */
async function first(page: Page, list: string, prefix: string, has?: string | RegExp, hasNot?: string): Promise<void> {
  await page.goto(list);
  const sel = `a[href^="${prefix}"]:not([href$="/new"])`;
  // Status chips sit beside the link in a list row, so a row is matched by all of its text.
  const filter = has ? { hasText: has, ...(hasNot ? { hasNotText: hasNot } : {}) } : null;
  let links = filter ? main(page).locator("li").filter(filter).locator(sel) : main(page).locator(sel);
  if (filter && !(await links.count())) links = main(page).locator(sel).filter(filter);
  const href = await links.first().getAttribute("href");
  if (!href) throw new Error(`no link ${prefix} on ${list}`);
  await page.goto(href);
}
async function one<T extends Record<string, unknown>>(ctx: ShotCtx, sql: string): Promise<T> {
  if (!ctx.query) throw new Error("needs the staging database");
  const [row] = await ctx.query<T>(sql);
  if (!row) throw new Error(`nothing found: ${sql}`);
  return row;
}

const DEPUTY = PRACTICE_USER_EMAILS.deputy;
/** The sign-up card on a deputy's detail page. */
const signUpCard = (page: Page) => page.locator("#sign-up");
/** The first invoice in Billing, Waiting that the deputy can act on, found before any button is pressed. */
const payableNow = (page: Page) => main(page).getByRole("article").filter({ has: page.getByRole("button", { name: /^Mark received/ }) }).first();
let payableLabel = "";
async function openPayable(page: Page): Promise<Locator> {
  await page.goto("/billing?tab=waiting");
  payableLabel = (await payableNow(page).getAttribute("aria-label")) ?? "";
  return payableNow(page);
}
const payable = (page: Page) => main(page).getByRole("article", { name: payableLabel, exact: true }).first();
/** Set on the practice deputy by the capture, on staging only, so the sign-in pages can be shown for real. From DEMO_PASSWORD, or random for each run. */
export const DEMO_PASSWORD = demoPassword();

/* ------------------------------------------------------------------------------------------------------------------ */
/* Deputy manual                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

async function signInForm(page: Page) {
  await page.goto("/sign-in");
  await page.getByLabel("Email").fill(DEPUTY);
  await page.getByLabel("Password").fill(DEMO_PASSWORD);
}
add("deputy", "signed-out", "01-signing-in", 1, B, signInForm, { fresh: true, stagingOnly: true });
add(
  "deputy",
  "signed-out",
  "01-signing-in",
  2,
  B,
  async (page) => {
    await signInForm(page);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("heading", { name: "Enter your sign-in code" }).waitFor();
  },
  { fresh: true, stagingOnly: true },
);

deputy("02-phone-and-desktop", 1, P, visit("/home"));
deputy("02-phone-and-desktop", 2, D, visit("/home"));
deputy("02-phone-and-desktop", 3, P, async (page) => {
  await first(page, "/home", "/jobs/");
  await top(main(page).getByRole("button", { name: "Open in Maps" }));
});

deputy("03-profile-and-w9", 1, B, visit("/profile"), { target: card("W-9") });
deputy("04-mailing-address", 1, B, visit("/profile"), { target: card("Contact") });

deputy("05-work-schedule-and-calendar-link", 1, B, visit("/profile"), { target: card("My schedule") });
deputy("05-work-schedule-and-calendar-link", 2, B, visit("/profile"), { target: card("Outlook calendar") });
deputy("05-work-schedule-and-calendar-link", 3, B, visit("/calendar"), { target: card("Calendar link") });

deputy("06-hidden-vendors", 1, B, visit("/jobs"), { target: (page) => main(page).getByRole("list", { name: "Details" }).getByRole("listitem").filter({ hasText: "Hide this vendor" }).first() });
deputy("06-hidden-vendors", 2, B, visit("/profile"), { target: card("Goal and hidden vendors") });

deputy("07-finding-and-sorting-details", 1, B, visit("/jobs"));
deputy("07-finding-and-sorting-details", 2, P, async (page) => {
  await page.goto("/jobs");
  await main(page).getByRole("button", { name: "Filters" }).first().click();
});
deputy("07-finding-and-sorting-details", 3, B, visit("/home"), { target: region("Open for you") });

deputy("08-calendar", 1, B, visit("/calendar"));
deputy("08-calendar", 2, B, visit("/calendar"), { target: (page) => main(page).getByRole("list", { name: "Color key" }) });

deputy("09-map", 1, B, visit("/map"));
deputy("09-map", 2, B, async (page) => {
  await page.goto("/map");
  // A pin, not a zoom button; Leaflet listens for the click on the pin itself, wherever the map placed it.
  await main(page).getByRole("region", { name: "Map of details" }).locator(".leaflet-marker-icon").first().dispatchEvent("click");
});

deputy("10-open-in-maps", 1, B, async (page) => {
  await first(page, "/home", "/jobs/");
  const button = main(page).getByRole("button", { name: "Open in Maps" }).first();
  await button.scrollIntoViewIfNeeded();
  await button.click();
});

// Billing and locks come first: the lock shows while a past detail is unbilled.
deputy("18-locks", 1, B, visit("/home"));
deputy("18-locks", 2, B, async (page) => {
  await first(page, "/jobs?open=1", "/jobs/", /spots? left/);
}, { target: signUpCard });

deputy("14-billing-a-detail", 1, B, visit("/billing"));
deputy("14-billing-a-detail", 2, B, async (page) => {
  await page.goto("/billing");
  await page.goto((await main(page).getByRole("link", { name: "Review and send invoice" }).first().getAttribute("href"))!);
});
deputy("14-billing-a-detail", 3, B, async (page) => {
  await page.goto("/billing");
  await page.goto((await main(page).getByRole("link", { name: "Review and send invoice" }).first().getAttribute("href"))!);
  await main(page).getByRole("button", { name: "Check the times" }).click().catch(() => undefined);
  await top(main(page).getByText("Hours worked").first());
});

// Sending the invoice clears the practice deputy's billing lock, so the sign-up pictures that follow show an open sign-up.
deputy("14-billing-a-detail", 4, B, async (page) => {
  await page.goto("/billing");
  const link = main(page).getByRole("link", { name: "Review and send invoice" });
  if (!(await link.count())) {
    await page.goto("/billing?tab=waiting");
    return;
  }
  await page.goto((await link.first().getAttribute("href"))!);
  await main(page).getByRole("button", { name: /^(Send invoice|Submit for review)$/ }).click();
  await page.waitForURL(/\/billing(\?|$)/, { timeout: 20_000 }).catch(() => undefined);
  await page.goto("/billing?tab=waiting");
}, { fresh: true });

deputy("11-signing-up", 1, B, async (page) => {
  await first(page, "/jobs?open=1", "/jobs/", /spots? left/);
}, { target: signUpCard });
deputy("11-signing-up", 2, B, async (page) => {
  await first(page, "/jobs?open=1&flex=1", "/jobs/", /spots? left/);
}, { target: signUpCard });
deputy("11-signing-up", 3, B, async (page) => {
  await first(page, "/jobs", "/jobs/", "Full", "Signed up");
}, { target: signUpCard });

deputy("12-canceling", 1, B, async (page) => {
  await first(page, "/home", "/jobs/");
  const r = region("Your sign-up")(page);
  await r.getByLabel("Reason for canceling").fill("Family event that evening");
}, { target: region("Your sign-up") });

deputy(
  "13-reactivated-details",
  1,
  B,
  async (page, ctx) => {
    const row = await one<{ id: string }>(ctx, "select entity_id as id from audit_log where action = 'job.reactivate' and entity_id in (select id::text from jobs where start_at > now()) order by at desc limit 1");
    await page.goto(`/jobs/${row.id}`);
  },
  { stagingOnly: true },
);

deputy(
  "15-late-cancel-pay",
  1,
  B,
  async (page, ctx) => {
    const row = await one<{ id: string }>(ctx, `select i.id from invoices i join users u on u.id = i.payee_user_id where u.email = '${DEPUTY}' and i.kind = 'late_cancel' order by i.created_at desc limit 1`);
    await page.goto(`/invoices/${row.id}`);
  },
  { stagingOnly: true },
);

deputy(
  "16-marking-paid",
  1,
  B,
  async (page) => {
    await openPayable(page);
  },
  { target: payable },
);
deputy("16-marking-paid", 2, B, async (page) => {
  await (await openPayable(page)).getByRole("button", { name: /^Mark received/ }).click();
}, { target: payable });
deputy("17-reporting-non-payment", 1, B, async (page) => {
  await page.goto("/billing?tab=waiting");
  const card = main(page).getByRole("article").filter({ has: page.getByRole("button", { name: /^(Report non-payment|Never arrived)/ }) }).first();
  payableLabel = (await card.getAttribute("aria-label")) ?? "";
  await card.getByRole("button", { name: /^(Report non-payment|Never arrived)/ }).click();
}, { target: payable });

deputy("19-earnings-and-tax-summary", 1, B, visit("/billing/earnings"));
deputy("19-earnings-and-tax-summary", 2, B, visit("/billing/earnings"), { target: card("Tax summary") });

deputy(
  "20-ops-plans",
  1,
  B,
  async (page, ctx) => {
    const row = await one<{ id: string }>(ctx, `select j.id from jobs j join assignments a on a.job_id = j.id join users u on u.id = a.user_id where j.title = 'Fireworks over the bay' and j.start_at > now() and u.email = '${DEPUTY}' and a.status = 'signed_up' order by j.start_at limit 1`);
    await page.goto(`/jobs/${row.id}`);
  },
  { stagingOnly: true },
);
deputy(
  "20-ops-plans",
  2,
  B,
  async (page, ctx) => {
    const row = await one<{ id: string }>(ctx, `select j.id from jobs j join assignments a on a.job_id = j.id join users u on u.id = a.user_id where j.title = 'Fireworks over the bay' and j.start_at > now() and u.email = '${DEPUTY}' and a.status = 'signed_up' order by j.start_at limit 1`);
    await page.goto(`/jobs/${row.id}`);
  },
  { stagingOnly: true, target: card("Ops plan") },
);

deputy("21-alerts-and-notification-preferences", 1, B, visit("/alerts"));
deputy("21-alerts-and-notification-preferences", 2, D, visit("/profile"), { target: card("Alerts") });

deputy("22-theme", 1, B, visit("/profile"), { target: card("Theme") });
deputy("22-theme", 2, D, visit("/home"), { target: (page) => page.locator('[data-shell="top-nav"]') });

/* ------------------------------------------------------------------------------------------------------------------ */
/* Vendor manual                                                                                                       */
/* ------------------------------------------------------------------------------------------------------------------ */

add("vendor", "signed-out", "01-signing-in", 1, B, visit("/sign-in"), { fresh: true, stagingOnly: true });

vendor("02-requesting-a-detail", 1, B, visit("/vendor/request"));
vendor("02-requesting-a-detail", 2, B, async (page) => {
  await page.goto("/vendor/request");
  await main(page).getByRole("button", { name: "More dates" }).click();
  await main(page).getByRole("button", { name: "Flexible times" }).click();
}, { target: card("When") });
vendor("02-requesting-a-detail", 3, B, visit("/vendor/request"), { target: card("Who you need") });
vendor("02-requesting-a-detail", 4, B, async (page) => {
  await page.goto("/vendor/request");
  await main(page).getByRole("button", { name: "Officer safety" }).click();
  await main(page).getByRole("button", { name: "Attachments" }).click();
}, { target: card("Safety and attachments") });

vendor("03-site-contacts", 1, B, visit("/vendor/locations"), { target: region("Site contacts") });
vendor("03-site-contacts", 2, B, visit("/vendor/request"), { target: card("Contact on site") });

vendor("04-locations", 1, B, visit("/vendor/locations"));
vendor("04-locations", 2, B, async (page) => {
  await page.goto("/vendor/locations");
  const b = main(page).getByRole("button", { name: "Open in Maps" }).first();
  await b.scrollIntoViewIfNeeded();
  await b.click();
});

vendor("05-your-details", 1, B, visit("/vendor"));
vendor("05-your-details", 2, B, (page) => first(page, "/vendor", "/vendor/details/", "Scheduled"));

vendor("06-editing-and-canceling", 1, B, async (page) => {
  await first(page, "/vendor", "/vendor/details/", "Scheduled");
}, { target: card("Changes") });
vendor("06-editing-and-canceling", 2, B, async (page) => {
  await first(page, "/vendor", "/vendor/details/", /(^|\D)0 of \d+ filled/);
  await main(page).getByRole("button", { name: "Change detail" }).click();
}, { target: card("Changes") });

vendor("07-invoices-and-marking-paid", 1, B, visit("/vendor/invoices"));
vendor("07-invoices-and-marking-paid", 2, B, async (page) => {
  await page.goto("/vendor/invoices");
  await main(page).getByRole("button", { name: /^Mark paid, invoice/ }).first().click();
}, { target: (page) => main(page).getByRole("article").first() });
vendor("07-invoices-and-marking-paid", 3, B, visit("/vendor/invoices"), {
  target: (page) => main(page).getByRole("article").filter({ hasText: /You marked paid|Paid\./ }).first(),
});

vendor("08-downloading-contracts-and-invoices", 1, B, visit("/vendor/contracts"));

/* ------------------------------------------------------------------------------------------------------------------ */
/* Coordinator and admin manual                                                                                        */
/* ------------------------------------------------------------------------------------------------------------------ */

const signedUpDetail = (page: Page, ctx: ShotCtx) =>
  one<{ id: string }>(ctx, "select j.id from jobs j where j.start_at > now() + interval '1 day' and j.state = 'scheduled' and exists (select 1 from assignments a where a.job_id = j.id and a.status = 'signed_up') order by j.start_at limit 1").then((r) =>
    page.goto(`/jobs/${r.id}?tab=manage`),
  );

coord("01-to-do", 1, D, visit("/coordinate"));
coord("01-to-do", 2, P, visit("/more"));
coord("01-to-do", 3, D, visit("/home"));

coord("02-creating-details", 1, D, visit("/jobs/new"));
coord("02-creating-details", 2, D, async (page) => {
  await page.goto("/jobs/new");
  await main(page).getByRole("tab", { name: "Pick dates" }).click();
  await main(page).getByLabel("Flexible times").check();
}, { target: card("When") });
coord("02-creating-details", 3, D, async (page) => {
  await page.goto("/jobs/new");
  await main(page).getByRole("tab", { name: "Repeat" }).click();
}, { target: card("When") });
coord("02-creating-details", 4, D, visit("/jobs/new"), { target: card("Positions") });
coord("02-creating-details", 5, D, async (page) => {
  await page.goto("/jobs/new");
  await main(page).getByRole("button", { name: "Add an address" }).click();
}, { target: card("Officer safety (optional)") });
coord("02-creating-details", 6, D, visit("/jobs/new"), { target: card("Ops plan and release") });
coord("02-creating-details", 7, D, async (page, ctx) => {
  await signedUpDetail(page, ctx);
  await top(main(page).getByRole("button", { name: /^Make (copy|\d+ copies)$/ }).locator("xpath=ancestor::form[1]"));
}, { stagingOnly: true });

coord("03-position-rate-differentials", 1, D, visit("/admin/positions"));
coord("03-position-rate-differentials", 2, D, async (page) => {
  await page.goto("/admin/positions");
  await main(page).getByRole("button", { name: "Edit Incident Commander" }).click();
});

coord("04-rate-range-and-exceptions", 1, D, async (page) => {
  await page.goto("/admin");
  await page.goto((await main(page).getByRole("link", { name: "Billing and invoices" }).getAttribute("href"))!);
});

coord("05-address-field", 1, D, async (page) => {
  await first(page, "/coordinate/vendors", "/coordinate/vendors/0");
  await main(page).getByRole("button", { name: "Add location" }).click();
  const field = main(page).getByLabel("Address").first();
  await field.fill("100 Harbor Blvd, Bayside, FL");
  await field.blur();
  await lookupDone(page);
  await top(field);
});

coord("06-site-contacts", 1, D, (page) => first(page, "/coordinate/vendors", "/coordinate/vendors/0"), { target: region(/^Site contacts/) });
coord("06-site-contacts", 2, D, async (page) => {
  await page.goto("/jobs/new");
  const vendorSelect = main(page).getByLabel("Vendor");
  await vendorSelect.selectOption({ index: 1 });
  // The vendor's contacts are offered once a vendor is chosen.
  await main(page).getByLabel("Site contact").and(page.locator(":enabled")).waitFor();
}, { target: card("Vendor and place") });

coord("07-attach-contract", 1, D, async (page, ctx) => {
  await signedUpDetail(page, ctx);
}, { stagingOnly: true, target: (page) => main(page).getByRole("form", { name: "Attach contract" }) });

coord("08-quick-and-bulk-edit", 1, D, async (page, ctx) => {
  await signedUpDetail(page, ctx);
}, { stagingOnly: true, target: card("Quick edit") });
coord("08-quick-and-bulk-edit", 3, D, async (page, ctx) => {
  await signedUpDetail(page, ctx);
  await main(page).getByRole("button", { name: "Edit detail" }).first().click();
  await top(main(page).getByRole("heading", { name: "Edit detail" }));
}, { stagingOnly: true });
coord("08-quick-and-bulk-edit", 2, D, async (page) => {
  await page.goto("/jobs");
  const boxes = main(page).getByRole("checkbox", { name: /^Select (?!all)/ });
  await boxes.nth(0).check();
  await boxes.nth(1).check();
  await main(page).getByRole("button", { name: "Edit selected" }).click();
  await top(main(page).getByRole("heading", { name: "Edit 2 details" }));
});

coord("10-hold-and-release", 1, D, async (page, ctx) => {
  const row = await one<{ id: string }>(ctx, "select id from jobs where held and start_at > now() order by start_at limit 1");
  await page.goto(`/jobs/${row.id}?tab=manage`);
}, { stagingOnly: true, target: card("Manage") });

coord("11-canceling-and-reactivating", 1, D, visit("/jobs?view=canceled&f=1"));
/** A scheduled detail well ahead (no late-cancel pay), with nobody on it; `n` picks a different one. */
const quietDetail = (ctx: ShotCtx, n: number) =>
  one<{ id: string }>(ctx, `select j.id from jobs j where j.state = 'scheduled' and j.start_at > now() + interval '5 days' and not j.held and not exists (select 1 from assignments a where a.job_id = j.id and a.status in ('signed_up','pending_short','backup')) order by j.start_at offset ${n} limit 1`);
async function openCancel(page: Page) {
  await main(page).getByRole("button", { name: "Cancel detail" }).first().click();
  await main(page).getByLabel("Reason", { exact: true }).filter({ visible: true }).first().fill("Vendor postponed the event");
}
coord("11-canceling-and-reactivating", 2, D, async (page, ctx) => {
  await page.goto(`/jobs/${(await quietDetail(ctx, 0)).id}?tab=manage`);
  await openCancel(page);
  await top(main(page).getByLabel("Reason", { exact: true }).filter({ visible: true }).first());
}, { stagingOnly: true });
coord("11-canceling-and-reactivating", 3, D, async (page, ctx) => {
  await page.goto(`/jobs/${(await quietDetail(ctx, 1)).id}?tab=manage`);
  await openCancel(page);
  await main(page).getByRole("button", { name: "Cancel detail" }).last().click();
  await main(page).getByRole("button", { name: "Reactivate detail" }).click();
  await top(main(page).getByTestId("reactivate-confirm"));
}, { stagingOnly: true });

coord("12-vendor-requests", 1, D, visit("/jobs?view=requests&f=1"));
coord("12-vendor-requests", 2, D, (page) => first(page, "/jobs?view=requests&f=1", "/jobs/"));

coord("13-assigning-and-removing", 1, D, async (page, ctx) => {
  await signedUpDetail(page, ctx);
}, { stagingOnly: true, target: card("Staffing") });

coord("14-sign-up-history", 1, D, async (page, ctx) => {
  const row = await one<{ id: string }>(ctx, "select entity_id as id from audit_log where action = 'job.reactivate' order by at desc limit 1");
  await page.goto(`/jobs/${row.id}?tab=manage`);
  await top(main(page).getByText("Sign-up history, oldest first"));
}, { stagingOnly: true });

coord("15-no-shows-and-suspensions", 1, D, async (page, ctx) => {
  const row = await one<{ id: string }>(ctx, "select j.id from jobs j where j.end_at < now() and j.end_at > now() - interval '20 days' and j.state <> 'canceled' and exists (select 1 from assignments a where a.job_id = j.id and a.status in ('signed_up','billed')) order by j.end_at desc limit 1");
  await page.goto(`/jobs/${row.id}?tab=manage`);
}, { stagingOnly: true, target: card("Staffing") });
coord("15-no-shows-and-suspensions", 2, D, async (page, ctx) => {
  const row = await one<{ id: string }>(ctx, "select id from users where suspension_reason is not null limit 1");
  await page.goto(`/admin/users/${row.id}`);
  await top(main(page).getByText(/suspend/i).first());
}, { stagingOnly: true });

coord("16-vendors-and-payment-holds", 1, D, visit("/coordinate/vendors"));
coord("16-vendors-and-payment-holds", 2, D, (page) => first(page, "/coordinate/vendors", "/coordinate/vendors/0"));

coord("17-locations-and-pins", 1, D, async (page) => {
  await first(page, "/coordinate/vendors", "/coordinate/vendors/0");
  await main(page).getByRole("button", { name: "Edit Main site" }).click();
  const address = main(page).getByLabel("Address").first();
  await address.waitFor();
  await top(address);
});

coord("18-invoice-review", 1, D, visit("/coordinate"), { target: region(/^Invoices to review/) });
coord("18-invoice-review", 2, D, async (page) => {
  await page.goto("/coordinate");
  await region(/^Invoices to review/)(page).getByRole("link", { name: /^Edit or send back/ }).first().click();
  await page.waitForURL(/\/invoices\//);
});
async function openPayment(page: Page) {
  await page.goto("/coordinate/payments");
  await main(page).getByRole("link", { name: /^ED-\d+$/ }).first().click();
  await main(page).locator('a[href^="/invoices/"]').first().waitFor();
}
coord("18-invoice-review", 3, D, async (page) => {
  await openPayment(page);
  await page.goto((await main(page).locator('a[href^="/invoices/"]').first().getAttribute("href"))!);
});

coord("19-sending-invoices", 1, D, visit("/coordinate/send-invoices"));
coord("19-sending-invoices", 2, D, (page) => first(page, "/coordinate/vendors", "/coordinate/vendors/0"), {
  target: (page) => main(page).getByLabel("Send this vendor's invoices").locator("xpath=ancestor::*[contains(@class,'rounded-xl')][1]"),
});

coord("20-payment-responsibility-and-issues", 1, D, visit("/coordinate/payments"));
coord("20-payment-responsibility-and-issues", 2, D, openPayment);

coord("21-ops-plan-review-and-library", 1, D, visit("/coordinate/ops-plans"));

coord("22-reports-and-exports", 1, D, visit("/coordinate/reports"));
coord("23-personnel-activity-report", 1, D, visit("/coordinate/reports/activity"));

coord("24-users-and-ranks", 1, D, visit("/admin/users"));
coord("24-users-and-ranks", 2, D, visit("/admin/ranks"));
// The departure checklist before anything changes: a deputy with upcoming sign-ups, and unbilled or unpaid work if any.
coord("24-users-and-ranks", 3, D, async (page, ctx) => {
  const row = await one<{ id: string }>(
    ctx,
    `select u.id from users u where u.role = 'personnel' and u.active and u.suspension_reason is null
      and exists (select 1 from assignments a join jobs j on j.id = a.job_id where a.user_id = u.id and a.status in ('signed_up', 'backup') and j.start_at > now())
     order by (exists (select 1 from invoices i where i.payee_user_id = u.id and i.status in ('sent', 'pending_review', 'approved_unsent', 'ready_to_send')))::int
       + (exists (select 1 from assignments a join jobs j on j.id = a.job_id where a.user_id = u.id and a.status in ('signed_up', 'late_canceled') and j.end_at < now() and a.written_off_at is null))::int desc, u.name
     limit 1`,
  );
  await page.goto(`/admin/users/${row.id}`);
  await main(page).getByRole("button", { name: "Deactivate user" }).click();
  await main(page).getByLabel("Reason").fill("Took a position with another agency");
  await main(page).getByRole("button", { name: "Review checklist" }).click();
  await main(page).getByRole("group", { name: /^Checklist for/ }).waitFor();
}, { stagingOnly: true, target: card("Access") });

coord("25-settings", 1, D, visit("/admin"));
coord("25-settings", 2, D, visit("/admin/seasons"));

coord("26-agency-notification-settings", 1, D, visit("/admin/settings/notifications"));

coord("28-training-mode", 1, D, async (page) => {
  await page.goto("/coordinate");
  await page.locator('[data-shell="top-nav"]').getByRole("button", { name: "Switch to training" }).click();
}, { fresh: true, stagingOnly: true, target: (page) => page.locator('[data-shell="top-nav"]') });
coord("28-training-mode", 2, P, visit("/more"), { fresh: true, stagingOnly: true });
coord("28-training-mode", 3, B, async (page) => {
  await page.goto("/more");
  await main(page).getByRole("button", { name: "Switch to training" }).click();
  await main(page).getByRole("radio", { name: "Deputy" }).check();
  await main(page).getByRole("button", { name: "Start training" }).click();
  await page.getByRole("region", { name: "Training mode" }).waitFor();
  await page.goto("/home");
}, { fresh: true, stagingOnly: true });

coord("29-email-outbox", 1, D, visit("/coordinate/outbox"));

admin("30-api-keys-and-data-export", 1, D, visit("/admin/api"));
admin("31-email-server-and-security", 1, D, visit("/admin/system"));
admin("31-email-server-and-security", 2, D, visit("/admin/system/security"));

/** A made-up logo for the demo agency (never a real agency's artwork). */
async function demoLogo(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="360" height="120"><rect width="360" height="120" rx="14" fill="#1d3b6e"/><circle cx="60" cy="60" r="38" fill="none" stroke="#f2c14e" stroke-width="8"/><path d="M60 34 66 52h19l-15 11 6 18-16-11-16 11 6-18-15-11h19z" fill="#f2c14e"/><text x="118" y="56" font-family="Arial" font-size="30" font-weight="700" fill="#ffffff">BAYSIDE</text><text x="118" y="90" font-family="Arial" font-size="20" fill="#cfd8e8">COUNTY DEMO</text></svg>`;
  const path = join(tmpdir(), "bayside-demo-logo.png");
  writeFileSync(path, await sharp(Buffer.from(svg)).png().toBuffer());
  return path;
}
admin("27-agency-logo", 1, D, async (page) => {
  await page.goto("/admin/agency");
  await main(page).locator('input[type="file"]').first().setInputFiles(await demoLogo());
  await Promise.all([
    page.waitForResponse((r) => r.url().endsWith("/api/v1/agency/logo") && r.request().method() === "POST"),
    main(page).getByRole("button", { name: "Upload logo" }).click(),
  ]);
  await page.reload();
}, { target: card("Logo") });
admin("27-agency-logo", 2, D, visit("/coordinate"), { target: (page) => page.locator('[data-shell="top-nav"]') });
admin("27-agency-logo", 3, P, visit("/coordinate"));

export const SHOTS: Shot[] = shots;
