import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:https";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { CalendarFetchError, requestPinned } from "@/domain/planning/calendar-fetch";

/**
 * The real requester against a local TLS server with a self-signed certificate. The address check lives in
 * fetchCalendarText, so calling the requester directly stands in for "the check allowed 127.0.0.1". The
 * hostname never resolves, so a connection can only arrive if the requester used the pinned address, and the
 * server records the SNI name it was asked for.
 */
describe("requestPinned", () => {
  let server: Server;
  let dir: string;
  let port = 0;
  const seen: Array<{ sni: string | false }> = [];

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "ed-tls-"));
    execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", join(dir, "k.pem"), "-out", join(dir, "c.pem"), "-subj", "/CN=calendar.invalid", "-days", "1"], { stdio: "ignore" });
    const { createSecureContext } = await import("node:tls");
    const ctx = createSecureContext({ key: readFileSync(join(dir, "k.pem")), cert: readFileSync(join(dir, "c.pem")) });
    server = createServer({
      SNICallback: (name, cb) => {
        seen.push({ sni: name || false });
        cb(null, ctx);
      },
    });
    server.on("tlsClientError", () => {});
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(dir, { recursive: true, force: true });
  });

  test("connects to the pinned address and sends the real hostname as SNI", async () => {
    const attempt = requestPinned({ url: new URL(`https://calendar.invalid:${port}/cal.ics`), address: "127.0.0.1", family: 4, signal: new AbortController().signal });
    // The self-signed certificate is refused, which still proves where the connection went.
    await expect(attempt).rejects.toBeInstanceOf(CalendarFetchError);
    await expect(attempt).rejects.toThrow("the secure connection could not be verified");
    expect(seen).toHaveLength(1);
    expect(seen[0].sni).toBe("calendar.invalid");
  });
});
