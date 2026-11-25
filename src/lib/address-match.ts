/**
 * Address comparison for the address field: whether the geocoder's match reads the same as what the person typed
 * (so it is verified as is) or differs (so it is offered as "Did you mean"). Shared by the server and the browser.
 */

export type AddressDecision = "verified" | "suggest" | "unverified";

const WORDS: Record<string, string> = {
  street: "st", avenue: "ave", road: "rd", drive: "dr", boulevard: "blvd", lane: "ln", court: "ct", highway: "hwy",
  parkway: "pkwy", place: "pl", circle: "cir", terrace: "ter", trail: "trl", square: "sq", suite: "ste", apartment: "apt",
  north: "n", south: "s", east: "e", west: "w", northeast: "ne", northwest: "nw", southeast: "se", southwest: "sw",
};

const STATES: Record<string, string> = {
  alabama: "al", alaska: "ak", arizona: "az", arkansas: "ar", california: "ca", colorado: "co", connecticut: "ct", delaware: "de",
  florida: "fl", georgia: "ga", hawaii: "hi", idaho: "id", illinois: "il", indiana: "in", iowa: "ia", kansas: "ks", kentucky: "ky",
  louisiana: "la", maine: "me", maryland: "md", massachusetts: "ma", michigan: "mi", minnesota: "mn", mississippi: "ms",
  missouri: "mo", montana: "mt", nebraska: "ne", nevada: "nv", "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm",
  "new york": "ny", "north carolina": "nc", "north dakota": "nd", ohio: "oh", oklahoma: "ok", oregon: "or", pennsylvania: "pa",
  "rhode island": "ri", "south carolina": "sc", "south dakota": "sd", tennessee: "tn", texas: "tx", utah: "ut", vermont: "vt",
  virginia: "va", washington: "wa", "west virginia": "wv", wisconsin: "wi", wyoming: "wy", "district of columbia": "dc",
};

/** Lowercase words with punctuation gone, ZIP+4 cut to five digits, state names and street words abbreviated, the country dropped. */
function tokens(address: string): string[] {
  let t = ` ${address.toLowerCase().replace(/(\d{5})-\d{4}\b/g, "$1").replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  t = t.replace(/ (united states of america|united states|usa)\s*$/, " ");
  for (const [name, code] of Object.entries(STATES)) if (name.includes(" ")) t = t.replaceAll(` ${name} `, ` ${code} `);
  return t
    .split(" ")
    .filter(Boolean)
    .map((w) => WORDS[w] ?? STATES[w] ?? w);
}

/** True when both read as the same address: the same words, in any order, once abbreviations are evened out. */
export function sameAddress(a: string, b: string): boolean {
  const x = tokens(a);
  const y = tokens(b);
  if (x.length === 0 || x.length !== y.length) return false;
  const left = [...x].sort();
  const right = [...y].sort();
  return left.every((w, i) => w === right[i]);
}

/** No match: not verified. A match that reads the same: verified. A different one: suggest it. */
export function addressDecision(typed: string, match: { label: string } | null): AddressDecision {
  if (!typed.trim() || !match) return "unverified";
  return sameAddress(typed, match.label) ? "verified" : "suggest";
}

/** A suite, apartment, unit, room, building or floor number, or "#12". The map never returns these. */
const UNIT = /\b(?:suite|ste|apartment|apt|unit|room|rm|building|bldg|floor)\.?\s*#?\s*[\p{L}\p{N}-]+|#\s*[\p{L}\p{N}-]+/giu;

/**
 * The map match with any unit the person typed put back after the street ("Use suggested" must not drop a suite
 * number). Units the match already has are left alone.
 */
export function withUnit(typed: string, label: string): string {
  const have = tokens(label);
  const missing = (typed.match(UNIT) ?? []).map((u) => u.trim().replace(/\s+/g, " ")).filter((u) => !tokens(u).every((w) => have.includes(w)));
  if (missing.length === 0) return label;
  const i = label.indexOf(",");
  return i === -1 ? `${label}, ${missing.join(", ")}` : `${label.slice(0, i)}, ${missing.join(", ")}${label.slice(i)}`;
}

type NominatimItem = { display_name?: unknown; address?: Record<string, unknown> };

/** "174 Lakeview Boulevard East, Gulf Haven, FL 32400" from a Nominatim result with address details. */
export function matchLabel(item: NominatimItem): string | null {
  const a = item.address ?? {};
  const s = (k: string) => (typeof a[k] === "string" ? (a[k] as string).trim() : "");
  const street = [s("house_number"), s("road")].filter(Boolean).join(" ");
  const place = s("city") || s("town") || s("village") || s("hamlet") || s("suburb");
  const iso = /^US-([A-Z]{2})$/.exec(s("ISO3166-2-lvl4"));
  const state = iso ? iso[1] : s("state");
  if (s("road")) return [street, place, [state, s("postcode")].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  const display = typeof item.display_name === "string" ? item.display_name.trim() : "";
  if (!display) return null;
  return display.replace(/,\s*(United States of America|United States|USA)\s*$/i, "");
}
