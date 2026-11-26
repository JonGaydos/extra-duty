import type { IncomingMessage } from "node:http";
import { BlockList, isIP } from "node:net";

/** "::ffff:192.0.2.1" as "192.0.2.1"; anything else unchanged. */
function plain(address: string): string {
  const a = address.trim();
  return a.toLowerCase().startsWith("::ffff:") && isIP(a.slice(7)) === 4 ? a.slice(7) : a;
}

/**
 * The proxies whose X-Forwarded-For is believed, from TRUSTED_PROXY: a comma-separated list of addresses or
 * CIDR ranges (for example the reverse proxy's Docker network, 172.16.0.0/12). Empty or unset trusts no one.
 */
export function parseTrustedProxies(value: string | undefined): BlockList | null {
  const entries = (value ?? "")
    .split(",")
    .map((e) => e.trim())
    .filter(Boolean);
  if (!entries.length) return null;
  const list = new BlockList();
  for (const entry of entries) {
    const [address, prefix] = entry.split("/") as [string, string | undefined];
    const family = isIP(address);
    if (!family || (prefix !== undefined && !/^\d{1,3}$/.test(prefix))) {
      throw new Error(`TRUSTED_PROXY has an entry that is not an address or CIDR range: "${entry}".`);
    }
    const type = family === 4 ? "ipv4" : "ipv6";
    if (prefix === undefined) list.addAddress(address, type);
    else list.addSubnet(address, Number(prefix), type);
  }
  return list;
}

function isTrusted(list: BlockList, address: string): boolean {
  const family = isIP(address);
  return family !== 0 && list.check(address, family === 4 ? "ipv4" : "ipv6");
}

/**
 * The client's address. The connection's own address unless it is a trusted proxy; then the X-Forwarded-For chain
 * is read from the right, skipping trusted proxies, and the first other address is the client. Entries a client
 * wrote itself sit to the left of the proxy's and are never reached.
 */
export function clientAddress(remote: string | undefined, forwardedFor: string | undefined, trusted: BlockList | null): string {
  const socket = plain(remote ?? "");
  if (!trusted || !isTrusted(trusted, socket)) return socket;
  const chain = (forwardedFor ?? "")
    .split(",")
    .map(plain)
    .filter(Boolean);
  for (let i = chain.length - 1; i >= 0; i--) {
    if (!isIP(chain[i])) return socket;
    if (!isTrusted(trusted, chain[i])) return chain[i];
  }
  return socket;
}

/**
 * Replaces the request's X-Forwarded-For with the one client address the app believes (see clientAddress), before
 * Next sees it. Sign-in throttling keys on this header, so a client can no longer choose its own address.
 */
export function setForwardedFor(req: IncomingMessage, trusted: BlockList | null): void {
  const raw = req.headers["x-forwarded-for"];
  const header = Array.isArray(raw) ? raw.join(",") : raw;
  req.headers["x-forwarded-for"] = clientAddress(req.socket.remoteAddress, header, trusted);
}
