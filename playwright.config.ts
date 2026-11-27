import { defineConfig } from "@playwright/test";
import { E2E } from "./tests/e2e/env";

/** The cross-role flow tests (tests/e2e/flows): recorded with video and a trace, so they can be watched afterwards. */
const FLOWS = /flows\/.+\.spec\.ts$/;
// Every step has a limit, so a frozen page fails its test (keeping the video so far) instead of hanging the run.
const RECORDED = { video: "on", trace: "on", actionTimeout: 15_000, navigationTimeout: 30_000 } as const;

export default defineConfig({
  testDir: "tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  // One app server and one database: run serially so first-hit compiles do not race.
  workers: 1,
  // The HTML report (playwright-report/) opens with scripts/e2e-report.sh.
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: E2E.baseURL,
    trace: "off",
    // E2E_CHROMIUM points at an already-installed Chromium when Playwright's own build is absent.
    launchOptions: process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {},
  },
  // E2E_FIREFOX=1 adds Firefox for the app-shell checks (Firefox Android keeps its toolbar only when the document never
  // scrolls) and for the flows.
  projects: [
    { name: "chromium", testIgnore: FLOWS, use: { browserName: "chromium" } },
    { name: "flows", testMatch: FLOWS, use: { browserName: "chromium", ...RECORDED } },
    ...(process.env.E2E_FIREFOX
      ? [
          { name: "firefox", testMatch: /app-shell\.spec\.ts/, use: { browserName: "firefox" as const, launchOptions: {} } },
          { name: "flows-firefox", testMatch: FLOWS, use: { browserName: "firefox" as const, launchOptions: {}, ...RECORDED } },
        ]
      : []),
  ],
  webServer: {
    command: "npx tsx --tsconfig tsconfig.node.json tests/e2e/server.ts",
    url: `${E2E.baseURL}/sign-in`,
    reuseExistingServer: false,
    timeout: 600_000,
    gracefulShutdown: { signal: "SIGTERM", timeout: 30_000 },
    stdout: "ignore",
    stderr: "pipe",
  },
});
