import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { GEOCODE_ANSWER_WITHIN_MS, GEOCODE_CACHE_MAX, GEOCODE_MAX_WAITING, GEOCODE_PER_USER_PER_MINUTE, geocodeAddress, lookupAddress, resetGeocoder } from "@/domain/vendors/geocode";

const HOUR = 3_600_000;
const item = (o: Record<string, unknown> = {}) => ({
  lat: "30.4",
  lon: "-86.2",
  display_name: "12615, US 1, Pine Harbor, Bayside County, Florida, 32401, United States",
  address: { house_number: "12615", road: "US 1", town: "Pine Harbor", state: "Florida", "ISO3166-2-lvl4": "US-FL", postcode: "32401", country: "United States" },
  ...o,
});
const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200 });

describe("geocoder", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    resetGeocoder();
    fetchMock = vi.fn(async () => ok([item()]));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  test("a match carries a short label and the point; the request names no person", async () => {
    vi.stubEnv("NOMINATIM_URL", "http://nominatim.test/search");
    const r = await lookupAddress("12615 US-1, Pine Harbor FL");
    expect(r).toEqual({ status: "match", match: { label: "12615 US 1, Pine Harbor, FL 32401", lat: 30.4, lng: -86.2 } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url.startsWith("http://nominatim.test/search?")).toBe(true);
    expect(url).toContain("addressdetails=1");
    expect(url).toContain("countrycodes=us");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("ExtraDuty/1.0");
  });

  test("lookups across callers start at least one second apart", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const starts: number[] = [];
    fetchMock.mockImplementation(async () => {
      starts.push(Date.now());
      return ok([item()]);
    });
    const all = Promise.all(["1 A St", "2 B St", "3 C St"].map((a) => lookupAddress(a)));
    await vi.advanceTimersByTimeAsync(2500);
    await all;
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(1000);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(1000);
  });

  test("matches and misses are cached; a failure is not", async () => {
    resetGeocoder({ intervalMs: 0 });
    await lookupAddress("10 Cache St");
    await lookupAddress("  10  CACHE st ");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    fetchMock.mockResolvedValueOnce(ok([]));
    expect(await lookupAddress("Nowhere Rd")).toEqual({ status: "none" });
    expect(await lookupAddress("nowhere rd")).toEqual({ status: "none" });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    fetchMock.mockResolvedValueOnce(new Response("busy", { status: 503 }));
    expect(await lookupAddress("Flaky Ave")).toEqual({ status: "unavailable" });
    expect(await lookupAddress("Flaky Ave")).toMatchObject({ status: "match" });
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("cached entries expire: a miss after an hour, a match after a day", async () => {
    resetGeocoder({ intervalMs: 0 });
    vi.useFakeTimers({ toFake: ["Date"] });
    fetchMock.mockResolvedValueOnce(ok([]));
    await lookupAddress("Late St");
    await lookupAddress("Early St");
    vi.setSystemTime(Date.now() + HOUR + 1);
    await lookupAddress("Late St");
    await lookupAddress("Early St");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    vi.setSystemTime(Date.now() + 24 * HOUR);
    await lookupAddress("Early St");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  test("the cache keeps at most its limit, dropping the least recently used", async () => {
    resetGeocoder({ intervalMs: 0 });
    for (let i = 0; i < GEOCODE_CACHE_MAX; i++) await lookupAddress(`${i} Fill St`);
    await lookupAddress("0 Fill St");
    expect(fetchMock).toHaveBeenCalledTimes(GEOCODE_CACHE_MAX);
    await lookupAddress("Newcomer St");
    await lookupAddress("0 Fill St");
    expect(fetchMock).toHaveBeenCalledTimes(GEOCODE_CACHE_MAX + 1);
    await lookupAddress("1 Fill St");
    expect(fetchMock).toHaveBeenCalledTimes(GEOCODE_CACHE_MAX + 2);
  });

  test("a long queue answers unavailable at once instead of waiting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "Date"] });
    const pending = Array.from({ length: GEOCODE_MAX_WAITING }, (_, i) => lookupAddress(`${i} Queue St`));
    expect(await lookupAddress("Overflow St")).toEqual({ status: "unavailable" });
    await vi.advanceTimersByTimeAsync(GEOCODE_MAX_WAITING * 1000 + 100);
    await Promise.all(pending);
  });

  test("geocodeAddress still answers a point or null", async () => {
    resetGeocoder({ intervalMs: 0 });
    expect(await geocodeAddress("12615 US-1")).toEqual({ lat: 30.4, lng: -86.2 });
    fetchMock.mockRejectedValueOnce(new Error("offline"));
    expect(await geocodeAddress("Offline St")).toBeNull();
  });

  test("one person gets at most 20 lookups a minute; others still get theirs", async () => {
    resetGeocoder({ intervalMs: 0 });
    vi.useFakeTimers({ toFake: ["Date"] });
    expect(GEOCODE_PER_USER_PER_MINUTE).toBe(20);
    for (let i = 0; i < GEOCODE_PER_USER_PER_MINUTE; i++) expect((await lookupAddress(`${i} Cap St`, { user: "u1" })).status).toBe("match");
    expect(await lookupAddress("Over Cap St", { user: "u1" })).toEqual({ status: "unavailable" });
    // A cached answer costs nothing.
    expect((await lookupAddress("0 Cap St", { user: "u1" })).status).toBe("match");
    expect((await lookupAddress("Other St", { user: "u2" })).status).toBe("match");
    vi.advanceTimersByTime(60_001);
    expect((await lookupAddress("Over Cap St", { user: "u1" })).status).toBe("match");
  });

  test("every answer comes within about 7 seconds: a turn too far off answers unavailable at once, a late one gets a shorter timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    expect(GEOCODE_ANSWER_WITHIN_MS).toBe(7000);
    const t0 = Date.now();
    // Nominatim never answers; only the timeout ends each lookup.
    fetchMock.mockImplementation((_url: string, init: RequestInit) => new Promise((_, reject) => init.signal!.addEventListener("abort", () => reject(new Error("aborted")))));
    const answered: number[] = [];
    const queued = Array.from({ length: 6 }, (_, i) => lookupAddress(`${i} Slow St`).then((r) => (answered.push(Date.now() - t0), r)));
    expect(await lookupAddress("Too Late St")).toEqual({ status: "unavailable" });
    await vi.advanceTimersByTimeAsync(GEOCODE_ANSWER_WITHIN_MS + 100);
    expect((await Promise.all(queued)).every((r) => r.status === "unavailable")).toBe(true);
    expect(Math.max(...answered)).toBeLessThanOrEqual(GEOCODE_ANSWER_WITHIN_MS);
  });
});
