import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

/** The tsx flags the Docker entrypoint starts the worker with, read from the entrypoint itself. */
function workerTsxFlags(): string[] {
  const entrypoint = readFileSync("scripts/docker-entrypoint.sh", "utf8");
  const match = /worker\) exec node_modules\/\.bin\/tsx (.*)src\/jobs\/worker\.ts/.exec(entrypoint);
  if (!match) throw new Error("No worker line in scripts/docker-entrypoint.sh");
  return match[1].split(/\s+/).filter(Boolean);
}

/** Runs the fixture under tsx with the given flags and checks that both PDFs come back. */
function expectPdfsRender(flags: string[]): void {
  // A tsx parent passes its tsconfig down in TSX_TSCONFIG_PATH; drop it so only the given flags count.
  const env: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production" };
  delete env.TSX_TSCONFIG_PATH;
  const run = spawnSync("node_modules/.bin/tsx", [...flags, "tests/unit/pdf/fixtures/render-pdfs.ts"], { env, encoding: "utf8", timeout: 60_000 });
  expect(run.status, run.stderr).toBe(0);
  const pdfs = JSON.parse(run.stdout) as { invoice: string; cover: string };
  for (const pdf of [pdfs.invoice, pdfs.cover]) {
    expect(Buffer.from(pdf, "base64").subarray(0, 4).toString("latin1")).toBe("%PDF");
  }
}

describe("PDFs in a tsx process, as the worker runs", () => {
  test("the invoice and batch cover PDFs render", () => {
    expectPdfsRender(workerTsxFlags());
  }, 60_000);

  test("they also render under plain tsx with no tsconfig flag", () => {
    expectPdfsRender([]);
  }, 60_000);
});
