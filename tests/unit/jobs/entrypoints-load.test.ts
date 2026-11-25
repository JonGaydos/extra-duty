import { spawnSync } from "node:child_process";
import { expect, test } from "vitest";

// The image runs the worker and the release step with tsx under plain Node ESM, not through Vitest's or Next's module
// interop. Every module they load must import cleanly there.
test("the worker and release step modules load under tsx as the container runs them", () => {
  const modules = ["./src/jobs/notification-worker.ts", "./src/jobs/email-worker.ts", "./src/jobs/schedule.ts", "./src/db/release.ts", "./src/db/rotate-file-key.ts", "./src/db/setup-email.ts"];
  const code = `Promise.all(${JSON.stringify(modules)}.map((m) => import(m))).then(() => console.log("loaded"))`;
  const r = spawnSync("node_modules/.bin/tsx", ["--eval", code], { encoding: "utf8", timeout: 60_000, env: { ...process.env, DATABASE_URL: "postgres://unused@127.0.0.1:1/unused" } });
  expect(r.stderr).toBe("");
  expect(r.stdout.trim()).toBe("loaded");
}, 70_000);
