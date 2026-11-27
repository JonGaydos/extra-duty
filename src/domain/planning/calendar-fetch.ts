import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { ValidationError } from "../errors";

/**
 * Server-side fetch of a deputy's calendar link. The link is a secret and the host is user supplied, so:
 * https only (webcal is https), the host is resolved here and every address must be public, the connection
 * goes to the address that was checked (so DNS cannot swap it afterwards), at most 3 redirects each re-checked,
 * a 10-second total timeout, a 5 MB limit enforced while streaming, no cookies or credentials, and no
 * logging of the URL. Failures carry only a short, generic reason.
 */

const MAX_BYTES = 5 * 1024 * 1024;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 3;
const MAX_URL_LENGTH = 2000;

/** A short, safe reason shown to the deputy. Never put the URL, host or a raw error message in it. */
export class CalendarFetchError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "CalendarFetchError";
  }
}

export type HopRequest = { url: URL; address: string; family: 4 | 6; signal: AbortSignal };
export type HopResponse = { status: number; location: string | null; body: AsyncIterable<Uint8Array>; close: () => void };

export type FetchDeps = {
  resolve: (host: string) => Promise<string[]>;
  request: (r: HopRequest) => Promise<HopResponse>;
  timeoutMs: number;
  maxBytes: number;
  maxRedirects: number;
};

/** Accepts https:// and webcal:// (treated as https); no embedded credentials. Returns the https URL. */
export function normalizeFeedUrl(raw: string): string {
  const fail = () => new ValidationError("Use an https:// or webcal:// calendar link.");
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text || text.length > MAX_URL_LENGTH) throw fail();
  const swapped = /^webcal:\/\//i.test(text) ? `https://${text.slice("webcal://".length)}` : text;
  let url: URL;
  try {
    url = new URL(swapped);
  } catch {
    throw fail();
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname) throw fail();
  return url.toString();
}

function parseV4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : Number.NaN));
  return out.every((n) => n >= 0 && n <= 255) ? out : null;
}

/** This host, private, loopback, CGNAT and link-local ranges. */
function privateV4(a: number, b: number): boolean {
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
  if (a === 169 && b === 254) return true; // link-local
  if (a === 172 && b >= 16 && b <= 31) return true;
  return a === 192 && b === 168;
}

function blockedV4([a, b, c]: number[]): boolean {
  if (privateV4(a, b)) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true; // IETF protocol, documentation
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224; // multicast, reserved, broadcast
}

/** 16 bytes of an IPv6 address, or null when it does not parse. Handles `::` and a trailing dotted IPv4. */
function parseV6(ip: string): number[] | null {
  if (ip.includes("%")) return null;
  let text = ip;
  const tail: number[] = [];
  const last = text.slice(text.lastIndexOf(":") + 1);
  if (/^\d+\.\d+\.\d+\.\d+$/.test(last)) {
    const v4 = parseV4(last);
    if (!v4) return null;
    tail.push((v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]);
    text = text.slice(0, -last.length) + "0:0";
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const groups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = groups(halves[0]);
  const rest = halves.length === 2 ? groups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 1 ? head.length !== 8 : missing < 1) return null;
  const all = halves.length === 1 ? head : [...head, ...new Array<string>(missing).fill("0"), ...rest];
  const words = all.map((g) => (/^[0-9a-f]{1,4}$/i.test(g) ? Number.parseInt(g, 16) : Number.NaN));
  if (words.some(Number.isNaN)) return null;
  if (tail.length) {
    words[6] = tail[0];
    words[7] = tail[1];
  }
  return words.flatMap((w) => [w >> 8, w & 255]);
}

/** True for anything that is not a public unicast address (and for anything that is not an address at all). */
export function isBlockedAddress(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const v4 = parseV4(ip);
    return !v4 || blockedV4(v4);
  }
  if (kind !== 6) return true;
  const b = parseV6(ip);
  if (!b) return true;
  const zeros = (from: number, to: number) => b.slice(from, to).every((x) => x === 0);
  if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff) return blockedV4(b.slice(12, 16)); // IPv4-mapped
  if (zeros(0, 12)) return true; // ::, ::1, IPv4-compatible
  if (b[0] === 0 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && zeros(4, 12)) return blockedV4(b.slice(12, 16)); // NAT64
  if (b[0] === 0x20 && b[1] === 0x02) return blockedV4(b.slice(2, 6)); // 6to4
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0 && b[3] === 0) return true; // Teredo
  if (b[0] === 0x20 && b[1] === 0x01 && b[2] === 0x0d && b[3] === 0xb8) return true; // documentation
  return (b[0] & 0xe0) !== 0x20; // only global unicast 2000::/3 passes
}

const defaultResolve = async (host: string): Promise<string[]> => {
  const rows = await lookup(host, { all: true, verbatim: true });
  return rows.map((r) => r.address);
};

/** Connects to the address that was checked; the Host header and TLS name stay the real host, never cookies or credentials. */
export const requestPinned = (r: HopRequest): Promise<HopResponse> =>
  new Promise((resolve, reject) => {
    const host = r.url.hostname.replace(/^\[|\]$/g, "");
    const req = httpsRequest(
      {
        host: r.address,
        servername: isIP(host) ? undefined : host,
        port: r.url.port || 443,
        path: `${r.url.pathname}${r.url.search}`,
        method: "GET",
        agent: false,
        headers: { Host: r.url.host, Accept: "text/calendar, text/plain, */*", "User-Agent": "Signal90-CalendarSync" },
        signal: r.signal,
      },
      (res) => {
        const location = typeof res.headers.location === "string" ? res.headers.location : null;
        resolve({ status: res.statusCode ?? 0, location, body: res, close: () => res.destroy() });
      },
    );
    req.on("error", (err: NodeJS.ErrnoException) => {
      if (r.signal.aborted) return reject(new CalendarFetchError("the server took too long"));
      const code = err.code ?? "";
      if (code === "ECONNREFUSED" || code === "EHOSTUNREACH" || code === "ENETUNREACH" || code === "ECONNRESET" || code === "ETIMEDOUT") {
        return reject(new CalendarFetchError("the server could not be reached"));
      }
      if (code.startsWith("ERR_TLS") || code.startsWith("CERT_") || code.includes("SELF_SIGNED") || code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" || code === "ERR_SSL_WRONG_VERSION_NUMBER") {
        return reject(new CalendarFetchError("the secure connection could not be verified"));
      }
      reject(new CalendarFetchError("the request failed"));
    });
    req.end();
  });

let override: Partial<FetchDeps> | null = null;
/** Tests install a resolver and a requester here; null restores the real ones. */
export function setCalendarFetchDeps(deps: Partial<FetchDeps> | null): void {
  override = deps;
}

/** Rejects with the timeout error as soon as the signal aborts, so a hung lookup cannot outlive the total timeout. */
function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const stop = () => reject(new CalendarFetchError("the server took too long"));
    if (signal.aborted) return stop();
    signal.addEventListener("abort", stop, { once: true });
    work.then(
      (v) => {
        signal.removeEventListener("abort", stop);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", stop);
        reject(e);
      },
    );
  });
}

async function readLimited(res: HopResponse, maxBytes: number, signal: AbortSignal): Promise<string> {
  const chunks: Uint8Array[] = [];
  let total = 0;
  const iterator = res.body[Symbol.asyncIterator]();
  const aborted = new Promise<never>((_, reject) => {
    const stop = () => reject(new CalendarFetchError("the server took too long"));
    if (signal.aborted) stop();
    else signal.addEventListener("abort", stop, { once: true });
  });
  aborted.catch(() => {});
  try {
    // Sequential: a stream is read one chunk at a time.
    for (;;) {
      const next = await Promise.race([iterator.next(), aborted]);
      if (next.done) break;
      total += next.value.byteLength;
      if (total > maxBytes) throw new CalendarFetchError(`the calendar is larger than ${Math.round(maxBytes / (1024 * 1024))} MB`);
      chunks.push(next.value);
    }
  } finally {
    res.close();
    void iterator.return?.()?.catch?.(() => {});
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** The checked address to connect to for this hop: every address the name resolves to must be public. */
async function checkedAddress(url: URL, deps: FetchDeps, signal: AbortSignal): Promise<string> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await abortable(deps.resolve(host), signal);
  if (addresses.length === 0) throw new CalendarFetchError("the address could not be found");
  if (addresses.some(isBlockedAddress)) throw new CalendarFetchError("that address is not allowed");
  return addresses[0];
}

/** Where a redirect points, when it is an https link with no credentials. */
function redirectTarget(location: string, url: URL): URL {
  let next: URL;
  try {
    next = new URL(location, url);
  } catch {
    throw new CalendarFetchError("the server sent a bad redirect");
  }
  if (next.protocol !== "https:" || next.username || next.password) throw new CalendarFetchError("the server redirected to a link that is not allowed");
  return next;
}

/** The error the deputy sees for a failed fetch: never the raw message or the URL. */
function shownFetchError(err: unknown, timedOut: boolean): CalendarFetchError {
  if (err instanceof CalendarFetchError) {
    return timedOut && err.message === "the request failed" ? new CalendarFetchError("the server took too long") : err;
  }
  if (err instanceof ValidationError) return new CalendarFetchError("the link is not allowed");
  return new CalendarFetchError(timedOut ? "the server took too long" : "the request failed");
}

/** The calendar text, or a CalendarFetchError whose message is safe to show the deputy. */
export async function fetchCalendarText(rawUrl: string, given: Partial<FetchDeps> = {}): Promise<string> {
  const deps: FetchDeps = {
    resolve: defaultResolve,
    request: requestPinned,
    timeoutMs: TIMEOUT_MS,
    maxBytes: MAX_BYTES,
    maxRedirects: MAX_REDIRECTS,
    ...override,
    ...given,
  };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs);
  try {
    let url = new URL(normalizeFeedUrl(rawUrl));
    // Sequential: each hop follows the previous answer's redirect.
    for (let hop = 0; ; hop++) {
      const address = await checkedAddress(url, deps, controller.signal);
      const res = await deps.request({ url, address, family: isIP(address) === 6 ? 6 : 4, signal: controller.signal });
      if (res.status >= 300 && res.status < 400 && res.location) {
        res.close();
        if (hop >= deps.maxRedirects) throw new CalendarFetchError("too many redirects");
        url = redirectTarget(res.location, url);
        continue;
      }
      if (res.status !== 200) {
        res.close();
        throw new CalendarFetchError(`the server answered ${res.status}`);
      }
      return await readLimited(res, deps.maxBytes, controller.signal);
    }
  } catch (err) {
    throw shownFetchError(err, controller.signal.aborted);
  } finally {
    clearTimeout(timer);
  }
}
