/**
 * Takes the user manuals' screenshots (docs/manuals/images) from demo data only, and refuses anything else:
 *
 *   Staging (APP_ENV=staging, on the demo agency):
 *     CAPTURE_BASE_URL=https://staging.example CAPTURE_DATABASE_URL=<staging database> BETTER_AUTH_SECRET=<staging's> \
 *       npx tsx scripts/capture-screenshots.ts
 *   The live site in training mode (a coordinator's or admin's session cookie value; the capture switches it to
 *   training as each role, and every page must show the training banner):
 *     CAPTURE_BASE_URL=https://details.example CAPTURE_SESSION_COOKIE=<better-auth.session_token> npx tsx scripts/capture-screenshots.ts
 *
 * Locally, against the e2e server on the demo agency: scripts/capture-local.sh.
 *
 * Every shot is taken at phone size (390 by 844) and/or desktop size (1280 by 800) in the day theme, saved as WebP,
 * and listed in images/manifest.json with where it came from. CAPTURE_ONLY=<regex> retakes only matching chapters
 * ("deputy/05"); otherwise images no shot produced are removed. Rerun it on every release so pictures match the app.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import sharp from "sharp";
import type { Browser, BrowserContext, Page } from "@playwright/test";
import type { PracticeRole } from "../src/domain/training/mode";
import type { ShotManifest, ShotRecord } from "../src/domain/manuals/manuals";
import { PRACTICE_USER_EMAILS } from "../src/domain/training/mode";
import { Refused, assertCapturable, contextFor, launch, resolveAccess, setDemoPassword, type Access, type Size } from "./capture/browser";
import { DEMO_PASSWORD, SHOTS, type Shot, type ShotCtx } from "./capture/shots";

const OUT = process.env.CAPTURE_OUT_DIR ?? join(process.cwd(), "docs", "manuals", "images");
const ONLY = process.env.CAPTURE_ONLY ? new RegExp(process.env.CAPTURE_ONLY) : null;

export const shotFile = (s: Shot, size: Size) => `${s.manual}/${s.chapter}-${s.step}-${size}.webp`;

async function main(): Promise<void> {
  const access = await resolveAccess(process.env);
  const shots = SHOTS.filter((s) => (!ONLY || ONLY.test(`${s.manual}/${s.chapter}`)) && (access.source === "staging" || !s.stagingOnly));
  // The sign-in pages are shown for real: the practice deputy gets a password, on staging only.
  if (access.source === "staging" && shots.some((s) => s.role === "signed-out")) await setDemoPassword(access, PRACTICE_USER_EMAILS.deputy, DEMO_PASSWORD);
  const browser = await launch();
  const records: ShotRecord[] = [];
  const failed: string[] = [];
  const db = access.source === "staging" ? new Client({ connectionString: access.databaseURL }) : null;
  await db?.connect();
  const query: ShotCtx["query"] = db ? async (sql, params) => (await db.query(sql, params)).rows : undefined;
  try {
    // Sequential: one role at a time; in training mode every context shares one session, which practices as one role.
    const roles = [...new Set(shots.map((s) => s.role))];
    for (const role of roles) await captureRole(browser, access, role, shots, query, records, failed);
  } finally {
    await browser.close();
    await db?.end();
  }
  if (failed.length) throw new Error(`${failed.length} screenshots failed; the manifest was not updated:\n${failed.join("\n")}`);
  writeManifest(access, records);
  console.log(`Captured ${records.length} screenshots into ${OUT}`);
}

/** One shot at one size, in its own page. A broken shot is listed in `failed`; a refusal stops the run. */
async function captureShot(context: BrowserContext, access: Access, shot: Shot, size: Size, role: string, query: ShotCtx["query"], records: ShotRecord[], failed: string[]): Promise<void> {
  const page = await context.newPage();
  try {
    records.push(await take(page, access, shot, size, role, query));
  } catch (err) {
    if (err instanceof Refused) throw err;
    // One broken shot does not stop the rest; the run still fails at the end.
    failed.push(`${shotFile(shot, size)}: ${(err as Error).message.split("\n")[0]}`);
    console.error(`  FAILED ${failed.at(-1)}`);
  } finally {
    await page.close();
    if (shot.fresh) await context.close();
  }
}

/** Every shot for one role, at each of its sizes. A broken shot is listed in `failed`; a refusal stops the run. */
async function captureRole(browser: Browser, access: Access, role: PracticeRole | "signed-out", shots: Shot[], query: ShotCtx["query"], records: ShotRecord[], failed: string[]): Promise<void> {
  const contexts = new Map<Size, BrowserContext>();
  try {
    // Sequential: shots of one role share its browser contexts and the session, and a page settles before its picture.
    for (const shot of shots.filter((s) => s.role === role)) {
      for (const size of shot.sizes) {
        const context = shot.fresh ? await contextFor(browser, access, role, size) : (contexts.get(size) ?? (await open(browser, access, role, size, contexts)));
        await captureShot(context, access, shot, size, role, query, records, failed);
      }
    }
  } finally {
    // Sequential: each context closes in turn; there are at most two.
    for (const c of contexts.values()) await c.close();
  }
}

async function open(browser: Browser, access: Access, role: PracticeRole | "signed-out", size: Size, contexts: Map<Size, BrowserContext>) {
  const c = await contextFor(browser, access, role, size);
  contexts.set(size, c);
  return c;
}

async function take(page: Page, access: Access, shot: Shot, size: Size, role: string, query: ShotCtx["query"]): Promise<ShotRecord> {
  await shot.go(page, { size, source: access.source, query });
  await page.waitForLoadState("networkidle").catch(() => undefined);
  // Let fonts and map tiles settle; caret and focus rings stay out of the picture.
  await page.evaluate(() => document.fonts.ready);
  await assertCapturable(page, access);
  const target = shot.target?.(page, size);
  const png = target ? await target.screenshot({ animations: "disabled", caret: "hide" }) : await page.screenshot({ animations: "disabled", caret: "hide", fullPage: shot.fullPage ?? false });
  const image = sharp(png);
  const meta = await image.metadata();
  const file = shotFile(shot, size);
  mkdirSync(join(OUT, shot.manual), { recursive: true });
  writeFileSync(join(OUT, file), await image.webp({ quality: 74, effort: 6 }).toBuffer());
  console.log(`  ${file}`);
  return { file, source: access.source, role, path: new URL(page.url()).pathname, size, width: meta.width!, height: meta.height! };
}

function writeManifest(access: Access, records: ShotRecord[]): void {
  const path = join(OUT, "manifest.json");
  let shots = records;
  if (ONLY && existsSync(path)) {
    const before = JSON.parse(readFileSync(path, "utf8")) as ShotManifest;
    const taken = new Set(records.map((r) => r.file));
    shots = [...before.shots.filter((s) => !taken.has(s.file) && !ONLY.test(s.file.replace(/-\d+-(phone|desktop)\.webp$/, ""))), ...records];
  }
  if (!ONLY) {
    // Pictures no shot produced any more are removed, so nothing stale ships.
    const keep = new Set(records.map((r) => r.file));
    for (const dir of readdirSync(OUT, { withFileTypes: true }).filter((d) => d.isDirectory())) {
      for (const f of readdirSync(join(OUT, dir.name))) if (!keep.has(`${dir.name}/${f}`)) rmSync(join(OUT, dir.name, f));
    }
  }
  shots.sort((a, b) => a.file.localeCompare(b.file, "en", { numeric: true }));
  const manifest: ShotManifest = { capturedAt: new Date().toISOString().slice(0, 10), source: access.source, shots };
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`);
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(err instanceof Refused ? err.message : err);
    process.exit(1);
  },
);
