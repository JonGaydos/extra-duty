import { expect, test, type Page } from "@playwright/test";
import { Client } from "pg";
import { PDFParse } from "pdf-parse";
import { E2E } from "./env";
import { signInAs } from "./session";

const banner = (page: Page) => page.getByRole("region", { name: "Training mode" });

async function startTraining(page: Page, role: "Deputy" | "Coordinator" | "Vendor") {
  await page.goto("/coordinate");
  await page.getByRole("button", { name: "Switch to training" }).click();
  await page.getByRole("radio", { name: role }).check();
  await page.getByRole("button", { name: "Start training" }).click();
  await expect(banner(page)).toContainText(`TRAINING: practicing as ${role}`);
}

async function backToLive(page: Page) {
  await banner(page).getByRole("button", { name: "Back to live" }).click();
  await expect(banner(page)).toHaveCount(0);
}

/** Every page in `paths` shows the banner and the person's training data, never an error page. */
async function everyPageHasBanner(page: Page, paths: string[], role: string) {
  for (const path of paths) {
    const res = await page.goto(path);
    expect(res?.status(), path).toBeLessThan(400);
    await expect(banner(page), path).toContainText(`TRAINING: practicing as ${role}`);
  }
}

test.describe.configure({ mode: "serial" });

test.use({ viewport: { width: 1280, height: 900 } });

test("a coordinator practices as a deputy: every page shows the banner, invoice PDFs say TRAINING, and back to live it is gone", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.goto("/coordinate");
  await expect(banner(page)).toHaveCount(0);
  await startTraining(page, "Deputy");
  await expect(page).toHaveURL(/\/home$/);
  await everyPageHasBanner(page, ["/home", "/jobs", "/map", "/calendar", "/billing", "/billing/earnings", "/alerts", "/messages", "/profile"], "Deputy");

  // An invoice PDF of the practice deputy, from the training database.
  const db = new Client({ connectionString: E2E.trainingDatabaseURL });
  await db.connect();
  let invoiceId: string;
  try {
    const { rows } = await db.query<{ id: string }>(
      "select i.id from invoices i join users u on u.id = i.payee_user_id where u.email = 'deputy@training.example' order by i.created_at desc limit 1",
    );
    invoiceId = rows[0].id;
  } finally {
    await db.end();
  }
  const pdf = await page.request.get(`/api/v1/invoices/${invoiceId}/pdf`);
  expect(pdf.status()).toBe(200);
  const text = (await new PDFParse({ data: await pdf.body() }).getText()).text;
  expect(text).toContain("TRAINING");

  await backToLive(page);
  await expect(page).toHaveURL(/\/coordinate$/);
  // The training invoice does not exist in live.
  expect((await page.request.get(`/api/v1/invoices/${invoiceId}/pdf`)).status()).toBe(404);
});

test("practicing as a coordinator: every staff page shows the banner, and the Outbox and reset are there", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await startTraining(page, "Coordinator");
  await everyPageHasBanner(
    page,
    ["/coordinate", "/coordinate/details", "/calendar", "/coordinate/vendors", "/coordinate/payments", "/coordinate/reports", "/coordinate/ops-plans", "/coordinate/send-invoices", "/messages", "/admin", "/coordinate/outbox"],
    "Coordinator",
  );
  await expect(page.getByRole("heading", { name: "Outbox", level: 1 })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset training data" })).toBeVisible();
  await expect(page.locator('[data-shell="top-nav"]').getByRole("link", { name: "Outbox" })).toBeVisible();
  await backToLive(page);
});

test("practicing as a vendor: the vendor pages show the banner", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await startTraining(page, "Vendor");
  await everyPageHasBanner(page, ["/vendor", "/vendor/request", "/vendor/invoices", "/vendor/locations", "/vendor/contracts"], "Vendor");
  await backToLive(page);
});

test("deputies are never offered training", async ({ page, context }) => {
  await signInAs(context, "deputy");
  await page.goto("/home");
  await expect(page.getByRole("button", { name: "Switch to training" })).toHaveCount(0);
  await expect(banner(page)).toHaveCount(0);
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("a coordinator switches to training and back from the More page", async ({ page, context }) => {
    await signInAs(context, "coordinator");
    await page.goto("/more");
    const training = page.getByRole("region", { name: "Training" });
    await training.getByRole("button", { name: "Switch to training" }).click();
    await training.getByRole("radio", { name: "Coordinator" }).check();
    await training.getByRole("button", { name: "Start training" }).click();
    await expect(banner(page)).toContainText("TRAINING: practicing as Coordinator");
    await page.goto("/more");
    await page.getByRole("region", { name: "Training" }).getByRole("button", { name: "Back to live data" }).click();
    await expect(banner(page)).toHaveCount(0);
    await page.goto("/more");
    await expect(page.getByRole("region", { name: "Training" }).getByRole("button", { name: "Switch to training" })).toBeVisible();
  });

  test("practicing as a deputy on a phone, the banner takes them back to live", async ({ page, context }) => {
    await signInAs(context, "coordinator");
    await page.goto("/more");
    const training = page.getByRole("region", { name: "Training" });
    await training.getByRole("button", { name: "Switch to training" }).click();
    await training.getByRole("radio", { name: "Deputy" }).check();
    await training.getByRole("button", { name: "Start training" }).click();
    await expect(banner(page)).toContainText("TRAINING: practicing as Deputy");
    await backToLive(page);
  });
});
