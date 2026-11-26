/** The address field's value and what it tells the server about the pin. Plain data, shared by forms and tests. */

/**
 * idle: not looked up since it was loaded or changed. checking: lookup running. verified: the map match reads the
 * same. suggest: the match differs and waits for Use suggested or Keep as entered. unverified: no match, the
 * lookup failed, or the person kept what they typed.
 */
type AddressState = "idle" | "checking" | "verified" | "suggest" | "unverified";
export type AddressValue = {
  address: string;
  lat: number | null;
  lng: number | null;
  /** auto: from the lookup. manual: placed by hand, and it overrides the lookup. */
  pin: "auto" | "manual" | null;
  state: AddressState;
  suggestion?: { label: string; lat: number; lng: number } | null;
  /** True when the lookup did not answer (offline, timeout, busy). */
  unavailable?: boolean;
};

export type PinWire = { lat: number; lng: number; source: "auto" | "manual" } | null | undefined;

/** A saved address: its stored pin, if any, counts as is until the address changes. */
export function addressValue(address: string | null | undefined, lat?: number | null, lng?: number | null, source: "auto" | "manual" = "auto"): AddressValue {
  const has = lat !== null && lat !== undefined && lng !== null && lng !== undefined;
  return { address: address ?? "", lat: has ? lat : null, lng: has ? lng : null, pin: has ? source : null, state: "idle" };
}

/**
 * What the server should do with the pin: the point to store (from the lookup or placed by hand); null for "store
 * no pin, do not look it up" (no match, or kept as typed); undefined for "look it up yourself" (never checked here).
 */
export function pinWire(v: AddressValue): PinWire {
  if (v.lat !== null && v.lng !== null && v.pin) return { lat: v.lat, lng: v.lng, source: v.pin };
  if (v.state === "unverified" && !v.unavailable) return null;
  return undefined;
}
