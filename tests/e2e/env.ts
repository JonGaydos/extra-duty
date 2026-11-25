/**
 * Fixed settings shared by the Playwright config, the e2e server script and
 * the test helpers. Fixed ports keep every Playwright process in agreement
 * without passing state between them.
 */
const port = Number(process.env.E2E_PORT ?? 3210);
const dbPort = Number(process.env.E2E_DB_PORT ?? 54329);

export const E2E = {
  port,
  dbPort,
  /** The stand-in for OpenStreetMap Nominatim (tests/e2e/fake-nominatim.ts). */
  nominatimPort: Number(process.env.E2E_NOMINATIM_PORT ?? port + 2),
  /** The test email capture (tests/e2e/fixtures.ts): the flow tests point the agency's SMTP settings here. */
  smtpPort: Number(process.env.E2E_SMTP_PORT ?? port + 3),
  baseURL: `http://localhost:${port}`,
  databaseURL: `postgres://postgres:postgres@127.0.0.1:${dbPort}/test`,
  /** Training mode's own database, on the same server, with the demo data (tests/e2e/server.ts). */
  trainingDatabaseURL: `postgres://postgres:postgres@127.0.0.1:${dbPort}/training`,
  /**
   * Test-only secrets; the e2e server never runs against real data. APP_ENV is production so sign-in codes are
   * emailed (to the test capture) rather than shown on screen; files stay on local disk.
   */
  appEnv: {
    BETTER_AUTH_SECRET: "e2e-only-better-auth-secret-0123456789abcdef",
    BETTER_AUTH_URL: `http://localhost:${port}`,
    SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
    FILE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
    APP_ENV: "production",
    STORAGE_DRIVER: "local",
    TRAINING_DATABASE_URL: `postgres://postgres:postgres@127.0.0.1:${dbPort}/training`,
    TRAINING_STORAGE_LOCAL_DIR: "test-results/e2e-training-storage",
  },
  screenshotDir: process.env.E2E_SCREENSHOT_DIR ?? "test-results/screenshots",
} as const;

/** Accounts created by the e2e server before the app starts. */
export const E2E_USERS = {
  deputy: { email: "deputy@e2e.test", name: "Sam Whitley", role: "personnel" },
  themeDeputy: { email: "theme@e2e.test", name: "Morgan Reyes", role: "personnel" },
  coordinator: { email: "coordinator@e2e.test", name: "Quinn Okafor", role: "coordinator" },
  admin: { email: "admin@e2e.test", name: "Alex Admin", role: "admin" },
  vendor: { email: "vendor@e2e.test", name: "Pat Morgan", role: "vendor" },
} as const;

/** Extra accounts the personnel fixtures create (signed in by email). */
export const E2E_EXTRA_USERS = {
  capped: { email: "capped@e2e.test" },
  riley: { email: "riley@e2e.test" },
  avery: { email: "avery.harmon@e2e.test" },
  suspensionRemoved: { email: "jordan.removed@e2e.test" },
  backOn: { email: "taylor.backon@e2e.test" },
} as const;

export type E2EUser = keyof typeof E2E_USERS;
