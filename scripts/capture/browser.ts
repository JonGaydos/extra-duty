import { createHmac, randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { chromium, type Browser, type BrowserContext, type Page } from "@playwright/test";
import { Client } from "pg";
import { uuidv7 } from "uuidv7";
import { PRACTICE_ROLE_LABELS, PRACTICE_USER_EMAILS, type PracticeRole } from "../../src/domain/training/mode";
import { captureRefusal } from "./guard";

export const VIEWPORTS = {
  phone: { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true },
  desktop: { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 },
} as const;
export type Size = keyof typeof VIEWPORTS;

export type Source = "staging" | "training";

/**
 * How the capture reaches demo data. Staging: a session for each practice account is written straight into the
 * staging database (CAPTURE_DATABASE_URL, signed with BETTER_AUTH_SECRET). Training: a coordinator's or admin's own
 * session cookie (CAPTURE_SESSION_COOKIE) on the live site, switched to training as each role in turn.
 */
export type Access =
  | { source: "staging"; baseURL: string; databaseURL: string; secret: string }
  | { source: "training"; baseURL: string; cookie: string };

export async function siteAppEnv(baseURL: string): Promise<string | undefined> {
  try {
    const res = await fetch(`${baseURL}/api/health`, { signal: AbortSignal.timeout(10_000) });
    const body = (await res.json()) as { appEnv?: unknown };
    return typeof body.appEnv === "string" ? body.appEnv : undefined;
  } catch {
    return undefined;
  }
}

export class Refused extends Error {}

/** Settles how to reach demo data, or refuses before anything is opened. */
export async function resolveAccess(env: NodeJS.ProcessEnv): Promise<Access> {
  const baseURL = (env.CAPTURE_BASE_URL ?? "http://localhost:3220").replace(/\/$/, "");
  const appEnv = await siteAppEnv(baseURL);
  if (appEnv === "staging") {
    if (!env.CAPTURE_DATABASE_URL || !env.BETTER_AUTH_SECRET) throw new Error("Staging capture needs CAPTURE_DATABASE_URL and BETTER_AUTH_SECRET (the staging site's own).");
    const db = new Client({ connectionString: env.CAPTURE_DATABASE_URL });
    await db.connect();
    try {
      const { rows } = await db.query<{ n: number }>("select count(*)::int as n from users where email = any($1)", [Object.values(PRACTICE_USER_EMAILS)]);
      if (rows[0].n !== 4) throw new Refused("Refusing to capture: this database does not hold the demo agency (the practice accounts are missing).");
    } finally {
      await db.end();
    }
    return { source: "staging", baseURL, databaseURL: env.CAPTURE_DATABASE_URL, secret: env.BETTER_AUTH_SECRET };
  }
  if (appEnv === "production" && env.CAPTURE_SESSION_COOKIE) return { source: "training", baseURL, cookie: env.CAPTURE_SESSION_COOKIE };
  throw new Refused(captureRefusal({ appEnv, trainingBanner: false })!);
}

const COOKIE = "better-auth.session_token";

async function stagingCookie(access: Extract<Access, { source: "staging" }>, email: string): Promise<string> {
  const db = new Client({ connectionString: access.databaseURL });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string }>("select id from users where email = $1", [email]);
    if (!rows[0]) throw new Error(`No demo account ${email}`);
    const token = randomBytes(24).toString("base64url");
    await db.query(
      "insert into sessions (id, token, user_id, expires_at, created_at, updated_at) values ($1, $2, $3, now() + interval '4 hours', now(), now())",
      [uuidv7(), token, rows[0].id],
    );
    return `${token}.${createHmac("sha256", access.secret).update(token).digest("base64")}`;
  } finally {
    await db.end();
  }
}

/** Gives a demo account a password (staging only), so the sign-in pages can be shown for real. */
export async function setDemoPassword(access: Extract<Access, { source: "staging" }>, email: string, password: string): Promise<void> {
  const db = new Client({ connectionString: access.databaseURL });
  await db.connect();
  try {
    const { rows } = await db.query<{ id: string }>("select id from users where email = $1", [email]);
    const hash = await hashPassword(password);
    await db.query("delete from accounts where user_id = $1 and provider_id = 'credential'", [rows[0].id]);
    await db.query("insert into accounts (id, account_id, provider_id, user_id, password, created_at, updated_at) values ($1, $2, 'credential', $2, $3, now(), now())", [
      uuidv7(),
      rows[0].id,
      hash,
    ]);
  } finally {
    await db.end();
  }
}

export const banner = (page: Page) => page.getByRole("region", { name: "Training mode" });

/** A browser context signed in as `role`'s demo account, at `size`, in the day theme. */
export async function contextFor(browser: Browser, access: Access, role: PracticeRole | "signed-out", size: Size): Promise<BrowserContext> {
  const context = await browser.newContext({ ...VIEWPORTS[size], baseURL: access.baseURL, colorScheme: "light", reducedMotion: "reduce" });
  // A step that cannot find its control fails that shot instead of waiting for ever.
  context.setDefaultTimeout(15_000);
  context.setDefaultNavigationTimeout(45_000);
  await context.addCookies([{ name: "ed-theme", value: "day", url: access.baseURL }]);
  if (role === "signed-out") return context;
  if (access.source === "staging") {
    await context.addCookies([{ name: COOKIE, value: await stagingCookie(access, PRACTICE_USER_EMAILS[role]), url: access.baseURL, httpOnly: true, sameSite: "Lax" }]);
    return context;
  }
  await context.addCookies([{ name: COOKIE, value: access.cookie, url: access.baseURL, httpOnly: true, sameSite: "Lax" }]);
  const page = await context.newPage();
  await page.goto("/more");
  const label = PRACTICE_ROLE_LABELS[role];
  if (!(await banner(page).getByText(`practicing as ${label}`).count())) {
    if (await banner(page).count()) {
      await banner(page).getByRole("button", { name: "Back to live" }).click();
      await page.waitForLoadState("networkidle");
    }
    await page.getByRole("button", { name: "Switch to training" }).first().click();
    await page.getByRole("radio", { name: label }).check();
    await page.getByRole("button", { name: "Start training" }).click();
    await banner(page).getByText(`practicing as ${label}`).waitFor();
  }
  await page.close();
  return context;
}

/** Throws Refused unless this page may be captured (staging, or the training banner is showing). */
export async function assertCapturable(page: Page, access: Access): Promise<void> {
  const appEnv = await siteAppEnv(access.baseURL);
  const trainingBanner = (await banner(page).count()) > 0 && (await banner(page).first().isVisible());
  const refusal = captureRefusal({ appEnv, trainingBanner });
  if (refusal) throw new Refused(refusal);
  if (access.source === "staging" && appEnv !== "staging") throw new Refused("Refusing to capture: the site stopped reporting staging.");
}

export function launch(): Promise<Browser> {
  return chromium.launch(process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {});
}
