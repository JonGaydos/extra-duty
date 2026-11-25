import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const env = {
  SECRETS_KEY: Buffer.alloc(32, 7).toString("base64"),
  FILE_MASTER_KEY: Buffer.alloc(32, 9).toString("base64"),
  BETTER_AUTH_SECRET: "test-only-better-auth-secret-0123456789abcdef",
  BETTER_AUTH_URL: "http://localhost:3000",
  APP_ENV: "production",
};
/** tsconfig keeps JSX for Next; tests compile it with the automatic runtime. */
const oxc = { jsx: { runtime: "automatic" as const } };
const alias = { "@": fileURLToPath(new URL("./src", import.meta.url)) };

export default defineConfig({
  test: {
    projects: [
      {
        resolve: { alias },
        oxc,
        test: { name: "unit", env, include: ["tests/unit/**/*.test.ts", "tests/unit/**/*.test.tsx"] },
      },
      {
        resolve: { alias },
        oxc,
        test: {
          name: "integration",
          env,
          include: ["tests/integration/**/*.test.ts"],
          testTimeout: 60_000,
          hookTimeout: 120_000,
          fileParallelism: false,
        },
      },
    ],
  },
});
