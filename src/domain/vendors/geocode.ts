import { matchLabel } from "@/lib/address-match";

export const GEOCODE_TIMEOUT_MS = 5000;
export const GEOCODE_MIN_INTERVAL_MS = 1000;
/** Most lookups kept in the cache; the least recently used goes first. */
export const GEOCODE_CACHE_MAX = 500;
/** Callers allowed to wait for a turn; past this a lookup answers "unavailable" at once rather than queueing. */
export const GEOCODE_MAX_WAITING = 20;
/** Every lookup answers within this (the address field gives up at 8 seconds): waiting for a turn plus the request. */
export const GEOCODE_ANSWER_WITHIN_MS = 7000;
/** A turn further off than this answers "unavailable" at once, leaving time for the request itself. */
const MAX_TURN_WAIT_MS = 5000;
/** Lookups one person may send to Nominatim per minute (cached answers do not count). */
export const GEOCODE_PER_USER_PER_MINUTE = 20;
const MATCH_TTL_MS = 24 * 3_600_000;
const MISS_TTL_MS = 3_600_000;
const DEFAULT_ENDPOINT = "https://nominatim.openstreetmap.org/search";
/** Generic on purpose: no person, email or agency name goes to the outside service. */
const USER_AGENT = "ExtraDuty/1.0";

export type LatLng = { lat: number; lng: number };
export type GeocodeMatch = LatLng & { label: string };
export type Lookup = { status: "match"; match: GeocodeMatch } | { status: "none" } | { status: "unavailable" };

// One process-wide cache and queue, shared by every request this server handles.
const cache = new Map<string, { at: number; value: Lookup }>();
let intervalMs = GEOCODE_MIN_INTERVAL_MS;
let lastStart = 0;
let waiting = 0;
let queue: Promise<void> = Promise.resolve();
const perUser = new Map<string, number[]>();

/** Test hook: clears the cache and rate-limit state, optionally shortening the spacing. */
export function resetGeocoder(opts: { intervalMs?: number } = {}): void {
  cache.clear();
  intervalMs = opts.intervalMs ?? GEOCODE_MIN_INTERVAL_MS;
  lastStart = 0;
  waiting = 0;
  queue = Promise.resolve();
  perUser.clear();
}

/** How long a caller arriving now would wait for its turn. */
function turnWait(): number {
  return waiting * intervalMs + Math.max(0, lastStart + intervalMs - Date.now());
}

/** Takes one of the person's lookups for this minute; false when they have used them all. */
function takeUserLookup(user: string): boolean {
  const now = Date.now();
  const recent = (perUser.get(user) ?? []).filter((t) => t > now - 60_000);
  const ok = recent.length < GEOCODE_PER_USER_PER_MINUTE;
  if (ok) recent.push(now);
  perUser.set(user, recent);
  return ok;
}

/** Waits for this caller's turn so requests start at least intervalMs apart. */
function takeTurn(): Promise<void> {
  waiting++;
  const turn = queue.then(async () => {
    const wait = lastStart + intervalMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastStart = Date.now();
    waiting--;
  });
  queue = turn;
  return turn;
}

function cached(key: string): Lookup | null {
  const hit = cache.get(key);
  if (!hit) return null;
  const ttl = hit.value.status === "match" ? MATCH_TTL_MS : MISS_TTL_MS;
  cache.delete(key);
  if (Date.now() - hit.at > ttl) return null;
  // Re-inserting keeps the Map in least-recently-used order.
  cache.set(key, hit);
  return hit.value;
}

function remember(key: string, value: Lookup): void {
  cache.set(key, { at: Date.now(), value });
  while (cache.size > GEOCODE_CACHE_MAX) cache.delete(cache.keys().next().value!);
}

function parse(body: unknown): GeocodeMatch | null {
  if (!Array.isArray(body) || body.length === 0) return null;
  const first = body[0] as { lat?: unknown; lon?: unknown; display_name?: unknown; address?: Record<string, unknown> };
  const lat = Number(first.lat);
  const lng = Number(first.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng, label: matchLabel(first) ?? "" };
}

/**
 * Looks an address up on OpenStreetMap Nominatim (US addresses). At most one request per second across the whole
 * server, matches cached for a day and misses for an hour. Every lookup answers within 7 seconds: a turn more than
 * 5 seconds off answers at once, and the request's own timeout (5 seconds) shrinks to fit. With `user`, one person
 * gets at most 20 lookups a minute. A failure, a timeout, a full queue or a used-up allowance answers
 * "unavailable" and is not cached: the address field shows Not verified and saving still goes ahead.
 */
export async function lookupAddress(address: string, opts: { user?: string } = {}): Promise<Lookup> {
  const started = Date.now();
  const key = address.trim().replace(/\s+/g, " ").toLowerCase();
  if (!key) return { status: "none" };
  const hit = cached(key);
  if (hit) return hit;
  if (waiting >= GEOCODE_MAX_WAITING || turnWait() > MAX_TURN_WAIT_MS) return { status: "unavailable" };
  if (opts.user !== undefined && !takeUserLookup(opts.user)) return { status: "unavailable" };
  await takeTurn();
  const budget = Math.min(GEOCODE_TIMEOUT_MS, started + GEOCODE_ANSWER_WITHIN_MS - Date.now());
  if (budget <= 0) return { status: "unavailable" };
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), budget);
  try {
    const endpoint = process.env.NOMINATIM_URL || DEFAULT_ENDPOINT;
    const url = `${endpoint}?format=jsonv2&addressdetails=1&countrycodes=us&limit=1&q=${encodeURIComponent(address.trim())}`;
    const res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT, Accept: "application/json", "Accept-Language": "en" },
      signal: abort.signal,
    });
    if (!res.ok) return { status: "unavailable" };
    const match = parse(await res.json());
    const value: Lookup = match ? { status: "match", match } : { status: "none" };
    remember(key, value);
    return value;
  } catch {
    return { status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

/** The point for an address, or null when there is none or the lookup failed: a missing pin never blocks saving. */
export async function geocodeAddress(address: string): Promise<LatLng | null> {
  const r = await lookupAddress(address);
  return r.status === "match" ? { lat: r.match.lat, lng: r.match.lng } : null;
}
