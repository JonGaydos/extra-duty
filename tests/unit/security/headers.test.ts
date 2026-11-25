import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { NextConfig } from "next";
import { describe, expect, test } from "vitest";

/** next.config.mjs is plain JavaScript (no types), so it is loaded by path. */
const loadConfig = async () => ((await import(pathToFileURL(resolve("next.config.mjs")).href)) as { default: NextConfig }).default;

/** Anti-framing (clickjacking) and basic hardening headers on every response; HSTS only where HTTPS is certain. */
describe("security headers", () => {
  test("next.config sends the anti-framing and hardening headers on every path", async () => {
    const rules = await (await loadConfig()).headers!();
    const all = rules.find((r) => r.source === "/:path*");
    expect(all).toBeTruthy();
    const h = Object.fromEntries(all!.headers.map((x) => [x.key.toLowerCase(), x.value]));
    expect(h["content-security-policy"]).toBe("frame-ancestors 'none'");
    expect(h["x-frame-options"]).toBe("DENY");
    expect(h["x-content-type-options"]).toBe("nosniff");
    expect(h["referrer-policy"]).toBe("same-origin");
    // The app is also served over plain HTTP on a LAN install, so HSTS never comes from the app.
    expect(h["strict-transport-security"]).toBeUndefined();
  });

  test("HSTS is sent by the HTTPS Caddy site only, never on the plain-LAN config or the HTTP redirect", async () => {
    const https = await readFile("docker/caddy/Caddyfile.https", "utf8");
    const lan = await readFile("docker/caddy/Caddyfile.lan", "utf8");
    const site = https.slice(https.indexOf("{$SITE_DOMAIN} {"), https.indexOf("http:// {"));
    expect(site).toMatch(/Strict-Transport-Security "max-age=\d+/);
    expect(https.slice(https.indexOf("http:// {"))).not.toMatch(/Strict-Transport-Security/);
    expect(lan).not.toMatch(/Strict-Transport-Security/);
  });
});
