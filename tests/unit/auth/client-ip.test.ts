import { request, createServer, type Server } from "node:http";
import { afterEach, describe, expect, test } from "vitest";
import { getIP } from "better-auth/api";
import { clientAddress, parseTrustedProxies, setForwardedFor } from "@/lib/client-ip";

describe("clientAddress", () => {
  test("without a trusted proxy the socket address wins and a client-supplied X-Forwarded-For is ignored", () => {
    expect(clientAddress("203.0.113.9", "198.51.100.1", null)).toBe("203.0.113.9");
    expect(clientAddress("::ffff:203.0.113.9", undefined, null)).toBe("203.0.113.9");
  });

  test("from the trusted proxy the address it appended is used", () => {
    const trusted = parseTrustedProxies("172.16.0.0/12");
    expect(clientAddress("172.18.0.5", "203.0.113.9", trusted)).toBe("203.0.113.9");
    // A forged entry before the proxy's own is skipped: the rightmost address not a trusted proxy is the client.
    expect(clientAddress("::ffff:172.18.0.5", "198.51.100.1, 203.0.113.9", trusted)).toBe("203.0.113.9");
  });

  test("a request that did not come from the trusted proxy cannot set its address", () => {
    const trusted = parseTrustedProxies("172.18.0.5");
    expect(clientAddress("203.0.113.9", "198.51.100.1", trusted)).toBe("203.0.113.9");
  });

  test("an empty or unset TRUSTED_PROXY trusts no one; a bad entry is an error", () => {
    expect(parseTrustedProxies(undefined)).toBeNull();
    expect(parseTrustedProxies(" ")).toBeNull();
    expect(() => parseTrustedProxies("caddy")).toThrow(/TRUSTED_PROXY/);
  });
});

describe("the web server's X-Forwarded-For", () => {
  let server: Server | undefined;
  afterEach(() => new Promise<void>((r) => (server ? server.close(() => r()) : r())));

  async function seen(trusted: string | undefined, xff?: string): Promise<string | null> {
    const proxies = parseTrustedProxies(trusted);
    server = createServer((req, res) => {
      setForwardedFor(req, proxies);
      const headers = new Headers({ "x-forwarded-for": String(req.headers["x-forwarded-for"] ?? "") });
      res.end(JSON.stringify({ ip: getIP(headers, {}) }));
    });
    await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
    const { port } = server.address() as { port: number };
    return new Promise((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path: "/", headers: xff ? { "x-forwarded-for": xff } : {} }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve((JSON.parse(body) as { ip: string | null }).ip));
      });
      req.on("error", reject);
      req.end();
    });
  }

  test("with no trusted proxy, a forged header does not change the address sign-in throttling sees", async () => {
    expect(await seen(undefined, "198.51.100.1")).toBe("127.0.0.1");
  });

  test("behind the trusted proxy, sign-in throttling sees the address the proxy set", async () => {
    expect(await seen("127.0.0.1", "203.0.113.9")).toBe("203.0.113.9");
  });
});
