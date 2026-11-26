import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { PDFParse } from "pdf-parse";
import { imageRefs, parseMarkdown } from "@/domain/manuals/markdown";
import { MANUALS, chapterFiles, type ManualId } from "@/domain/manuals/manuals";
import { E2E, E2E_EXTRA_USERS, E2E_USERS } from "./env";
import { signInAs } from "./session";
import { byText } from "@/lib/sort";

const ROOT = join(process.cwd(), "docs", "manuals");
const IMAGES = join(ROOT, "images");
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

/** Every chapter of a manual: its file, its Markdown and the images it names (resolved to files). */
function chapters(id: ManualId) {
  return chapterFiles(ROOT, id).map((file) => {
    const md = readFileSync(join(ROOT, id, file), "utf8");
    const blocks = parseMarkdown(md);
    return { file, md, blocks, images: imageRefs(blocks).map((src) => join(ROOT, id, src)) };
  });
}

test.describe("the manuals on disk", () => {
  test("each manual has chapters, and every image a chapter names exists", () => {
    for (const m of MANUALS) {
      const list = chapters(m.id);
      expect(list.length, m.id).toBeGreaterThan(4);
      for (const c of list) {
        expect(c.blocks[0], `${m.id}/${c.file} starts with its title`).toMatchObject({ type: "heading", level: 1 });
        expect(c.blocks.some((b) => b.type === "list" && b.ordered), `${m.id}/${c.file} has numbered steps`).toBe(true);
        for (const img of c.images) expect(existsSync(img), `${m.id}/${c.file}: ${img}`).toBe(true);
      }
    }
  });

  test("the manuals use plain text: no emojis and no em dashes", () => {
    for (const m of MANUALS) {
      for (const c of chapters(m.id)) {
        expect(c.md, `${m.id}/${c.file}`).not.toMatch(/—/);
        expect(c.md, `${m.id}/${c.file}`).not.toMatch(/\p{Extended_Pictographic}/u);
      }
    }
  });

  test("screenshots come only from demo data, and every image is used", () => {
    const manifest = JSON.parse(readFileSync(join(IMAGES, "manifest.json"), "utf8")) as {
      source: string;
      shots: Array<{ file: string; source: string }>;
    };
    expect(["staging", "training"]).toContain(manifest.source);
    const listed = new Set(manifest.shots.map((s) => s.file));
    for (const s of manifest.shots) expect(["staging", "training"], s.file).toContain(s.source);

    const referenced = new Set(MANUALS.flatMap((m) => chapters(m.id).flatMap((c) => c.images)).map((p) => p.slice(IMAGES.length + 1)));
    const onDisk = MANUALS.flatMap((m) => (existsSync(join(IMAGES, m.id)) ? readdirSync(join(IMAGES, m.id)).map((f) => `${m.id}/${f}`) : []));
    for (const f of onDisk) {
      expect(listed.has(f), `${f} was captured by scripts/capture-screenshots.ts`).toBe(true);
      // A desktop shot may stand beside the phone shot a chapter names.
      expect(referenced.has(f) || referenced.has(f.replace(/-desktop\.webp$/, "-phone.webp")), `${f} is used by a chapter`).toBe(true);
    }
    const bytes = onDisk.reduce((n, f) => n + statSync(join(IMAGES, f)).size, 0);
    expect(bytes).toBeLessThan(40 * 1024 * 1024);

    // No names or addresses from the e2e accounts (which stand in for real people) in any manual.
    const people = [...Object.values(E2E_USERS), ...Object.values(E2E_EXTRA_USERS)].map((u) => u.email);
    for (const m of MANUALS) for (const c of chapters(m.id)) for (const p of people) expect(c.md, `${m.id}/${c.file}`).not.toContain(p);
  });
});

test.describe("capture-screenshots", () => {
  test("refuses to run against live data", () => {
    // The e2e site is APP_ENV=production with live accounts. Even with its database and secret at hand, nothing is taken.
    const outDir = mkdtempSync(join(tmpdir(), "capture-"));
    const out = spawnSync("npx", ["tsx", "scripts/capture-screenshots.ts"], {
      env: {
        ...process.env,
        CAPTURE_BASE_URL: E2E.baseURL,
        CAPTURE_DATABASE_URL: E2E.databaseURL,
        BETTER_AUTH_SECRET: E2E.appEnv.BETTER_AUTH_SECRET,
        CAPTURE_OUT_DIR: outDir,
      },
      encoding: "utf8",
      timeout: 120_000,
    });
    expect(out.status).not.toBe(0);
    expect(out.stderr).toContain("Refusing to capture");
    expect(readdirSync(outDir)).toEqual([]);
  });
});

test("the build produces three PDFs with the agency header", () => {
  const dir = mkdtempSync(join(tmpdir(), "manuals-"));
  const out = spawnSync("npx", ["tsx", "scripts/build-manuals.ts", "--out", dir], {
    env: { ...process.env, DATABASE_URL: E2E.databaseURL },
    encoding: "utf8",
    timeout: 300_000,
  });
  expect(out.status, out.stderr).toBe(0);
  const pdfs = readdirSync(dir).filter((f) => f.endsWith(".pdf")).sort(byText);
  expect(pdfs).toHaveLength(3);
  return Promise.all(
    pdfs.map(async (f) => {
      const { text } = await new PDFParse({ data: new Uint8Array(readFileSync(join(dir, f))) }).getText();
      expect(text, f).toContain("Bayside County Sheriff's Office");
      expect(text, f).toMatch(/Deputy manual|Coordinator and admin manual|Vendor manual/);
    }),
  );
});

async function imagesLoaded(page: Page) {
  // The pictures load lazily; load them all now, then check none is broken.
  await page
    .getByRole("main")
    .locator("img")
    .evaluateAll((imgs) =>
      Promise.all(
        (imgs as HTMLImageElement[]).map((i) => {
          i.loading = "eager";
          return i.complete ? null : new Promise((done) => ((i.onload = done), (i.onerror = done)));
        }),
      ),
    );
  const broken = await page
    .getByRole("main")
    .locator("img")
    .evaluateAll((imgs) => (imgs as HTMLImageElement[]).filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.currentSrc || i.src));
  expect(broken).toEqual([]);
}

const ACCESS: Record<"deputy" | "coordinator" | "admin" | "vendor", ManualId[]> = {
  deputy: ["deputy"],
  coordinator: ["deputy", "coordinator-admin", "vendor"],
  admin: ["deputy", "coordinator-admin", "vendor"],
  vendor: ["vendor"],
};

for (const [who, allowed] of Object.entries(ACCESS) as [keyof typeof ACCESS, ManualId[]][]) {
  test(`${who} sees only their own manuals at /help, and every chapter renders`, async ({ page, context }) => {
    test.setTimeout(300_000);
    await signInAs(context, who);
    await page.setViewportSize(DESKTOP);
    await page.goto("/help");
    await expect(page.getByRole("heading", { level: 1, name: "Help" })).toBeVisible();
    for (const m of MANUALS) {
      const link = page.getByRole("main").getByRole("link", { name: m.title, exact: true });
      if (allowed.includes(m.id)) await expect(link).toBeVisible();
      else await expect(link).toHaveCount(0);
    }
    // Staff walk the coordinator manual; everyone else walks their own.
    const walk = allowed.includes("coordinator-admin") ? "coordinator-admin" : allowed[0];
    for (const [i, c] of chapters(walk).entries()) {
      if (i % 2 === 1) await page.setViewportSize(PHONE);
      else await page.setViewportSize(DESKTOP);
      const res = await page.goto(`/help/${walk}/${c.file.replace(/^\d+-/, "").replace(/\.md$/, "")}`);
      expect(res?.status(), c.file).toBe(200);
      await expect(page.getByRole("heading", { level: 1 })).toHaveText((c.blocks[0] as { text: string }).text);
      await imagesLoaded(page);
    }
    for (const m of MANUALS.filter((x) => !allowed.includes(x.id))) {
      expect((await page.goto(`/help/${m.id}`))?.status(), m.id).toBe(404);
      const first = chapters(m.id).find((c) => c.images.length);
      if (first) {
        const img = first.images[0].slice(ROOT.length + "/images/".length);
        expect((await page.request.get(`/help-images/${img}`)).status(), img).toBe(404);
      }
    }
  });
}

test("Help is reachable from the desktop top bar, the phone More page and a deputy's Profile", async ({ page, context }) => {
  await signInAs(context, "coordinator");
  await page.setViewportSize(DESKTOP);
  await page.goto("/coordinate");
  await page.locator('[data-shell="top-nav"]').getByRole("link", { name: "Help" }).click();
  await expect(page).toHaveURL(/\/help$/);
  await page.setViewportSize(PHONE);
  await page.goto("/more");
  await page.getByRole("main").getByRole("link", { name: "Help", exact: true }).click();
  await expect(page).toHaveURL(/\/help$/);

  await context.clearCookies();
  await signInAs(context, "deputy");
  await page.goto("/profile");
  await page.getByRole("main").getByRole("link", { name: "Help and user manual" }).click();
  await expect(page).toHaveURL(/\/help$/);
  await expect(page.getByRole("main").getByRole("link", { name: "Deputy manual", exact: true })).toBeVisible();
});

test("signed-out visitors cannot read Help or its images", async ({ page }) => {
  await page.goto("/help/deputy");
  await expect(page).toHaveURL(/\/sign-in/);
  const first = chapters("deputy").find((c) => c.images.length)!;
  const img = first.images[0].slice(ROOT.length + "/images/".length);
  expect((await page.request.get(`/help-images/${img}`, { maxRedirects: 0 })).status()).toBe(404);
});
