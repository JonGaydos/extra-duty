import { expect, test } from "@playwright/test";
import { Client } from "pg";
import { E2E } from "./env";
import { FIXTURE } from "./personnel-fixtures";
import { signInAs } from "./session";

/** Every detail is addressed and named by its number: /jobs/9, "Detail #9" and "#9". */

async function job(title: string): Promise<{ id: string; number: number }> {
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  try {
    return (await client.query<{ id: string; number: number }>("select id, number from jobs where title = $1 order by start_at limit 1", [title])).rows[0];
  } finally {
    await client.end();
  }
}

test.use({ viewport: { width: 1280, height: 900 } });

test("the number is the address; an old id address moves to it, with its query", async ({ page, context }) => {
  await signInAs(context, "deputy");
  const open = await job(FIXTURE.openJob);
  await page.goto(`/jobs/${open.number}`);
  await expect(page.getByRole("heading", { level: 1, name: FIXTURE.openJob })).toBeVisible();
  await expect(page.getByText(`Detail #${open.number}`, { exact: true })).toBeVisible();
  await page.goto(`/jobs/${open.id}?from=email`);
  await expect(page).toHaveURL(new RegExp(`/jobs/${open.number}\\?from=email$`));
});

test("a number the person may not see is not found, the same as one that does not exist", async ({ page, context }) => {
  await signInAs(context, "deputy");
  const request = await job(FIXTURE.requestedJob);
  expect((await page.goto(`/jobs/${request.number}`))?.status()).toBe(404);
  expect((await page.goto(`/jobs/${request.id}`))?.status()).toBe(404);
  expect((await page.goto("/jobs/999999999"))?.status()).toBe(404);
});

test("Go to detail # opens the detail, or says there is none the person can see", async ({ page, context }) => {
  await signInAs(context, "deputy");
  const open = await job(FIXTURE.openJob);
  const request = await job(FIXTURE.requestedJob);
  await page.goto("/jobs");
  const go = page.getByRole("search", { name: "Go to a detail" });
  await go.getByLabel("Go to detail #").fill(`#${open.number}`);
  await go.getByRole("button", { name: "Go" }).click();
  await expect(page).toHaveURL(new RegExp(`/jobs/${open.number}$`));
  await page.goto("/jobs");
  await go.getByLabel("Go to detail #").fill(String(request.number));
  await go.getByRole("button", { name: "Go" }).click();
  await expect(page.getByText(`No detail #${request.number} that you can see.`)).toBeVisible();
  // The filter keeps its own field, now named Detail number.
  await expect(page.getByRole("complementary", { name: "Filters" }).getByLabel("Detail number")).toBeVisible();
});

test("the number shows on rows, the calendar and the invoice", async ({ page, context }) => {
  await signInAs(context, "deputy");
  const open = await job(FIXTURE.openJob);
  await page.goto(`/jobs?f=1&num=${open.number}`);
  await expect(page.getByRole("main").getByText(`#${open.number} ${FIXTURE.openJob}`)).toBeVisible();
  await page.goto(`/calendar?view=list&f=1&num=${open.number}`);
  await expect(page.getByRole("main").getByText(new RegExp(`#${open.number} ${FIXTURE.openJob}`))).toBeVisible();
  const invoiced = await job(FIXTURE.invoicedJob);
  const client = new Client({ connectionString: E2E.databaseURL });
  await client.connect();
  const inv = (await client.query<{ id: string }>("select i.id from invoices i join assignments a on a.id = i.assignment_id where a.job_id = $1", [invoiced.id])).rows[0];
  await client.end();
  await page.goto(`/invoices/${inv.id}`);
  await expect(page.getByRole("main").getByText(new RegExp(`#${invoiced.number} ${FIXTURE.invoicedJob}`)).first()).toBeVisible();
});
