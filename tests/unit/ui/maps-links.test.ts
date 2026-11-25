import { describe, expect, test } from "vitest";
import { MAPS_APPS, mapsUrls } from "@/lib/maps";

describe("maps links", () => {
  test("pinned coordinates are used when present", () => {
    const u = mapsUrls({ address: "25 Town Square, Gulf Haven, FL 32400", lat: 29.3274, lng: -82.1627 });
    expect(u.google).toBe("https://www.google.com/maps/search/?api=1&query=29.3274%2C-82.1627");
    expect(u.apple).toBe("https://maps.apple.com/?q=25%20Town%20Square%2C%20Gulf%20Haven%2C%20FL%2032400&ll=29.3274,-82.1627");
    expect(u.osm).toBe("https://www.openstreetmap.org/?mlat=29.3274&mlon=-82.1627#map=17/29.3274/-82.1627");
  });

  test("the address text is used without coordinates", () => {
    const u = mapsUrls({ address: "350 Industrial Dr, Pine Harbor, FL", lat: null, lng: null });
    expect(u.google).toBe("https://www.google.com/maps/search/?api=1&query=350%20Industrial%20Dr%2C%20Pine%20Harbor%2C%20FL");
    expect(u.apple).toBe("https://maps.apple.com/?q=350%20Industrial%20Dr%2C%20Pine%20Harbor%2C%20FL");
    expect(u.osm).toBe("https://www.openstreetmap.org/search?query=350%20Industrial%20Dr%2C%20Pine%20Harbor%2C%20FL");
  });

  test("coordinates without an address still name the place for Apple Maps", () => {
    expect(mapsUrls({ address: null, lat: 30.5, lng: -86.1 }).apple).toBe("https://maps.apple.com/?q=30.5%2C-86.1&ll=30.5,-86.1");
  });

  test("three apps, in a fixed order, with their names", () => {
    expect(MAPS_APPS.map((a) => [a.key, a.name])).toEqual([
      ["google", "Google Maps"],
      ["apple", "Apple Maps"],
      ["osm", "OpenStreetMap"],
    ]);
  });
});
