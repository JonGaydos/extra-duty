/**
 * A stand-in for OpenStreetMap Nominatim during e2e runs, so the suite never calls the real service. Answers by
 * the words in `q`: a known address matches, "nowhere" finds nothing, "broken" fails with 503.
 */
import { createServer, type Server } from "node:http";

export const FAKE_NOMINATIM_PLACES = {
  pineHarbor: {
    lat: "29.4987",
    lon: "-82.1361",
    display_name: "12615, US 1, Pine Harbor, Bayside County, Florida, 32401, United States",
    address: { house_number: "12615", road: "US 1", town: "Pine Harbor", state: "Florida", "ISO3166-2-lvl4": "US-FL", postcode: "32401", country: "United States" },
  },
  lakeview: {
    lat: "29.3712",
    lon: "-82.2244",
    display_name: "174, Lakeview Boulevard East, Gulf Haven, Bayside County, Florida, 32400, United States",
    address: { house_number: "174", road: "Lakeview Boulevard East", hamlet: "Gulf Haven", state: "Florida", "ISO3166-2-lvl4": "US-FL", postcode: "32400", country: "United States" },
  },
} as const;

export function startFakeNominatim(port: number): Promise<Server> {
  const server = createServer((req, res) => {
    const q = (new URL(req.url ?? "/", "http://x").searchParams.get("q") ?? "").toLowerCase();
    if (q.includes("broken")) {
      res.writeHead(503, { "Content-Type": "text/plain" }).end("unavailable");
      return;
    }
    const body = q.includes("12615") ? [FAKE_NOMINATIM_PLACES.pineHarbor] : q.includes("174 lakeview") ? [FAKE_NOMINATIM_PLACES.lakeview] : [];
    res.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(body));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
