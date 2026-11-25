/** Links to a place in the three maps apps the agency offers. No API keys: each is a plain search or pin URL. */

export type MapsApp = "google" | "apple" | "osm";

export const MAPS_APPS: ReadonlyArray<{ key: MapsApp; name: string }> = [
  { key: "google", name: "Google Maps" },
  { key: "apple", name: "Apple Maps" },
  { key: "osm", name: "OpenStreetMap" },
];

export const isMapsApp = (v: unknown): v is MapsApp => v === "google" || v === "apple" || v === "osm";

export type Place = { address: string | null | undefined; lat: number | null | undefined; lng: number | null | undefined };

/** The pinned coordinates when there are any, else the address text. */
export function mapsUrls(p: Place): Record<MapsApp, string> {
  const pinned = typeof p.lat === "number" && typeof p.lng === "number";
  const ll = pinned ? `${p.lat},${p.lng}` : "";
  const q = encodeURIComponent(pinned ? ll : (p.address ?? ""));
  const name = encodeURIComponent(p.address?.trim() || ll);
  return {
    google: `https://www.google.com/maps/search/?api=1&query=${q}`,
    apple: `https://maps.apple.com/?q=${name}${pinned ? `&ll=${ll}` : ""}`,
    osm: pinned ? `https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lng}#map=17/${p.lat}/${p.lng}` : `https://www.openstreetmap.org/search?query=${q}`,
  };
}
