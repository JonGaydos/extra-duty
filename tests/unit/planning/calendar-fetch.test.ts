import { describe, expect, test } from "vitest";
import { ValidationError } from "@/domain/errors";
import { CalendarFetchError, fetchCalendarText, isBlockedAddress, normalizeFeedUrl, type HopRequest, type HopResponse } from "@/domain/planning/calendar-fetch";

const PUBLIC = "93.184.216.34";

const body = (text: string, chunk = 1024): AsyncIterable<Uint8Array> => ({
  async *[Symbol.asyncIterator]() {
    const bytes = new TextEncoder().encode(text);
    for (let i = 0; i < bytes.length; i += chunk) yield bytes.subarray(i, i + chunk);
  },
});
const ok = (text: string): HopResponse => ({ status: 200, location: null, body: body(text), close: () => {} });
const redirect = (location: string): HopResponse => ({ status: 302, location, body: body(""), close: () => {} });

function rig(handler: (r: HopRequest, n: number) => HopResponse | Promise<HopResponse>, addresses: Record<string, string[]> = {}) {
  const seen: HopRequest[] = [];
  const resolved: string[] = [];
  return {
    seen,
    resolved,
    deps: {
      resolve: async (host: string) => {
        resolved.push(host);
        return addresses[host] ?? [PUBLIC];
      },
      request: async (r: HopRequest) => {
        seen.push(r);
        return handler(r, seen.length);
      },
    },
  };
}

const fails = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(CalendarFetchError);
    return (e as Error).message;
  }
  throw new Error("expected the fetch to be refused");
};

describe("isBlockedAddress", () => {
  test.each([
    "0.0.0.0", "10.0.0.5", "127.0.0.1", "127.9.9.9", "169.254.169.254", "172.16.0.1", "172.31.255.255", "192.168.1.1",
    "100.64.0.1", "100.127.255.255", "224.0.0.1", "239.255.255.255", "255.255.255.255", "240.0.0.1", "192.0.0.1", "198.18.0.1",
    "::", "::1", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1", "::ffff:10.0.0.5", "::ffff:127.0.0.1", "::ffff:a00:5", "::10.0.0.5",
    "64:ff9b::a00:5", "2002:a00:5::1", "2001:db8::1", "fec0::1", "2001:0:4136:e378:8000:63bf:3fff:fdd2",
  ])("blocks %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(true);
  });

  test.each(["93.184.216.34", "8.8.8.8", "172.32.0.1", "100.128.0.1", "2606:4700:4700::1111", "2a00:1450:4001:81b::200e", "::ffff:8.8.8.8"])("allows %s", (ip) => {
    expect(isBlockedAddress(ip)).toBe(false);
  });

  test("anything that is not an address is blocked", () => {
    expect(isBlockedAddress("not-an-ip")).toBe(true);
    expect(isBlockedAddress("fe80::1%eth0")).toBe(true);
  });
});

describe("normalizeFeedUrl", () => {
  test("accepts https and treats webcal as https", () => {
    expect(normalizeFeedUrl("https://outlook.office365.com/owa/calendar/x/y/calendar.ics")).toBe("https://outlook.office365.com/owa/calendar/x/y/calendar.ics");
    expect(normalizeFeedUrl("webcal://example.com/cal.ics")).toBe("https://example.com/cal.ics");
    expect(normalizeFeedUrl("WEBCAL://example.com/cal.ics")).toBe("https://example.com/cal.ics");
  });
  test.each(["http://example.com/a.ics", "ftp://example.com/a.ics", "file:///etc/passwd", "javascript:alert(1)", "https://user:pw@example.com/a.ics", "not a url", ""])("rejects %s", (u) => {
    expect(() => normalizeFeedUrl(u)).toThrow(ValidationError);
  });
});

describe("fetchCalendarText", () => {
  test("fetches over https from the address it checked and passes no cookies or credentials", async () => {
    const r = rig(() => ok("BEGIN:VCALENDAR"));
    expect(await fetchCalendarText("webcal://example.com/cal.ics", r.deps)).toBe("BEGIN:VCALENDAR");
    expect(r.seen).toHaveLength(1);
    expect(r.seen[0].url.toString()).toBe("https://example.com/cal.ics");
    expect(r.seen[0].address).toBe(PUBLIC);
    expect(r.seen[0].family).toBe(4);
  });

  test.each([
    ["10.0.0.5"], ["127.0.0.1"], ["169.254.169.254"], ["100.64.1.1"], ["::1"], ["fd00::5"], ["::ffff:10.0.0.5"], ["0.0.0.0"], ["224.0.0.5"],
  ])("refuses a host that resolves to %s and never connects", async (addr) => {
    const r = rig(() => ok("x"), { "example.com": [addr] });
    const msg = await fails(fetchCalendarText("https://example.com/cal.ics", r.deps));
    expect(msg).toBe("that address is not allowed");
    expect(r.seen).toHaveLength(0);
  });

  test("refuses when any resolved address is private (mixed answers)", async () => {
    const r = rig(() => ok("x"), { "example.com": [PUBLIC, "10.0.0.5"] });
    await fails(fetchCalendarText("https://example.com/cal.ics", r.deps));
    expect(r.seen).toHaveLength(0);
  });

  test("refuses literal private addresses without resolving", async () => {
    for (const u of ["https://10.0.0.5/a.ics", "https://[::1]/a.ics", "https://[::ffff:10.0.0.5]/a.ics", "https://127.1/a.ics", "https://2130706433/a.ics", "https://0x7f.0.0.1/a.ics"]) {
      const r = rig(() => ok("x"));
      await fails(fetchCalendarText(u, r.deps));
      expect(r.seen).toHaveLength(0);
      expect(r.resolved).toHaveLength(0);
    }
  });

  test("pins the checked address: a second lookup that would answer differently is never used", async () => {
    let n = 0;
    const seen: HopRequest[] = [];
    const deps = {
      resolve: async () => (n++ === 0 ? [PUBLIC] : ["10.0.0.5"]),
      request: async (r: HopRequest) => {
        seen.push(r);
        return ok("done");
      },
    };
    await fetchCalendarText("https://rebind.example/cal.ics", deps);
    expect(n).toBe(1);
    expect(seen[0].address).toBe(PUBLIC);
  });

  test("an unresolvable host is a short error", async () => {
    const msg = await fails(fetchCalendarText("https://example.com/a.ics", { resolve: async () => [], request: async () => ok("x") }));
    expect(msg).toBe("the address could not be found");
  });

  test("follows up to 3 redirects and re-checks every target", async () => {
    const r = rig((req) => (req.url.pathname === "/a" ? redirect("/b") : req.url.pathname === "/b" ? redirect("https://other.example/c") : req.url.pathname === "/c" ? redirect("/d") : ok("end")));
    expect(await fetchCalendarText("https://example.com/a", r.deps)).toBe("end");
    expect(r.resolved).toEqual(["example.com", "example.com", "other.example", "other.example"]);

    const tooMany = rig((req) => redirect(`/n${req.url.pathname.length}`));
    expect(await fails(fetchCalendarText("https://example.com/a", tooMany.deps))).toBe("too many redirects");
    expect(tooMany.seen).toHaveLength(4);
  });

  test("a redirect to a private address or to http is refused", async () => {
    const toPrivate = rig((req) => (req.url.hostname === "example.com" ? redirect("https://internal.example/x") : ok("secret")), { "internal.example": ["192.168.1.10"] });
    await fails(fetchCalendarText("https://example.com/a", toPrivate.deps));
    expect(toPrivate.seen).toHaveLength(1);

    const toHttp = rig(() => redirect("http://example.com/plain"));
    await fails(fetchCalendarText("https://example.com/a", toHttp.deps));
    const toLiteral = rig(() => redirect("https://169.254.169.254/latest/meta-data"));
    await fails(fetchCalendarText("https://example.com/a", toLiteral.deps));
    expect(toLiteral.seen).toHaveLength(1);
  });

  test("the size limit is enforced while streaming", async () => {
    let pulled = 0;
    const endless: AsyncIterable<Uint8Array> = {
      async *[Symbol.asyncIterator]() {
        for (;;) {
          pulled += 1;
          yield new Uint8Array(1024 * 1024);
        }
      },
    };
    let closed = false;
    const r = rig(() => ({ status: 200, location: null, body: endless, close: () => (closed = true) }));
    expect(await fails(fetchCalendarText("https://example.com/a", r.deps))).toBe("the calendar is larger than 5 MB");
    expect(pulled).toBeLessThanOrEqual(6);
    expect(closed).toBe(true);
  });

  test("a non-200 answer is a short error", async () => {
    const r = rig(() => ({ status: 500, location: null, body: body(""), close: () => {} }));
    expect(await fails(fetchCalendarText("https://example.com/a", r.deps))).toBe("the server answered 500");
  });

  test("the total timeout aborts a request that hangs", async () => {
    const hang = rig((req) => new Promise<HopResponse>((_, reject) => req.signal.addEventListener("abort", () => reject(new Error("aborted")))));
    expect(await fails(fetchCalendarText("https://example.com/a", { ...hang.deps, timeoutMs: 30 }))).toBe("the server took too long");
  });

  test("the total timeout also covers name resolution", async () => {
    let connected = false;
    const hang = {
      resolve: () => new Promise<string[]>(() => {}),
      request: async () => {
        connected = true;
        return ok("x");
      },
      timeoutMs: 30,
    };
    expect(await fails(fetchCalendarText("https://example.com/a", hang))).toBe("the server took too long");
    expect(connected).toBe(false);
  });

  test("the timeout also covers a body that stalls", async () => {
    const stall: AsyncIterable<Uint8Array> = {
      [Symbol.asyncIterator]: () => ({ next: () => new Promise(() => {}) }),
    };
    const r = rig(() => ({ status: 200, location: null, body: stall, close: () => {} }));
    expect(await fails(fetchCalendarText("https://example.com/a", { ...r.deps, timeoutMs: 30 }))).toBe("the server took too long");
  });

  test("an unexpected error never leaks its message or the URL", async () => {
    const r = rig(() => {
      throw new Error("connect ECONNREFUSED secret-host.example:443 /private/token");
    });
    const msg = await fails(fetchCalendarText("https://secret-host.example/private/token", r.deps));
    expect(msg).toBe("the request failed");
  });
});
