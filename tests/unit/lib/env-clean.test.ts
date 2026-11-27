import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { cleanEnv } from "@/lib/env-clean";

function run(env: Record<string, string | undefined>) {
  const warnings: string[] = [];
  cleanEnv(env, (m) => warnings.push(m));
  return warnings;
}

describe("cleaning settings an env file filled with a comment", () => {
  test("a URL setting that is not an http or https URL is unset, with one warning naming it", () => {
    const env: Record<string, string | undefined> = {
      APP_URL: "# optional; links in alert emails use it",
      BETTER_AUTH_URL: "localhost:3000",
      S3_ENDPOINT: "ftp://files.example.org",
    };
    const warnings = run(env);
    expect(env).toEqual({});
    expect(warnings).toHaveLength(3);
    expect(warnings[0]).toMatch(/APP_URL/);
    expect(warnings[1]).toMatch(/BETTER_AUTH_URL/);
    expect(warnings[2]).toMatch(/S3_ENDPOINT/);
  });

  test("valid URLs stay as they are", () => {
    const env = { APP_URL: "https://details.example.org", BETTER_AUTH_URL: "http://localhost:3000", S3_ENDPOINT: "https://nyc3.example.com" };
    expect(run(env)).toEqual([]);
    expect(env).toEqual({ APP_URL: "https://details.example.org", BETTER_AUTH_URL: "http://localhost:3000", S3_ENDPOINT: "https://nyc3.example.com" });
  });

  test("VAPID_SUBJECT keeps a mailto: or an https URL and drops anything else", () => {
    const mail = { VAPID_SUBJECT: "mailto:admin@example.org" };
    expect(run(mail)).toEqual([]);
    expect(mail.VAPID_SUBJECT).toBe("mailto:admin@example.org");
    const site = { VAPID_SUBJECT: "https://details.example.org" };
    expect(run(site)).toEqual([]);
    const bad: Record<string, string | undefined> = { VAPID_SUBJECT: "# mailto:you@example.org" };
    expect(run(bad)).toHaveLength(1);
    expect(bad.VAPID_SUBJECT).toBeUndefined();
  });

  test("an optional setting starting with # is unset, with one warning", () => {
    const env: Record<string, string | undefined> = {
      STAGING_EMAIL_ALLOWLIST: "# staging only: comma-separated addresses",
      VAPID_PUBLIC_KEY: "# web push keys",
      TRUSTED_PROXY: "# addresses or CIDR ranges",
      TRAINING_DATABASE_URL: "# empty turns training mode off",
    };
    const warnings = run(env);
    expect(env).toEqual({});
    expect(warnings).toHaveLength(4);
    for (const name of ["STAGING_EMAIL_ALLOWLIST", "VAPID_PUBLIC_KEY", "TRUSTED_PROXY", "TRAINING_DATABASE_URL"]) {
      expect(warnings.filter((w) => w.startsWith(`${name} `))).toHaveLength(1);
    }
  });

  test("empty values are unset quietly, and real values are kept", () => {
    const env: Record<string, string | undefined> = { APP_URL: "", STAGING_EMAIL_ALLOWLIST: "a@example.org,b@example.org", VAPID_PRIVATE_KEY: "abc123" };
    expect(run(env)).toEqual([]);
    expect(env).toEqual({ STAGING_EMAIL_ALLOWLIST: "a@example.org,b@example.org", VAPID_PRIVATE_KEY: "abc123" });
  });

  test("required secrets are never touched, even when they start with #", () => {
    const env = { BETTER_AUTH_SECRET: "#starts-with-a-hash-0123456789abcdef", DATABASE_URL: "postgres://u:p@h:5432/d" };
    expect(run(env)).toEqual([]);
    expect(env.BETTER_AUTH_SECRET).toBe("#starts-with-a-hash-0123456789abcdef");
  });
});

describe("the example env files", () => {
  test("keep every comment on its own line, never after a value", () => {
    for (const file of [".env.example", "app.env.example"]) {
      const inline = readFileSync(file, "utf8")
        .split("\n")
        .filter((line) => /^(# )?[A-Z][A-Z0-9_]*=/.test(line) && /\s#/.test(line));
      expect(inline, file).toEqual([]);
    }
  });
});
