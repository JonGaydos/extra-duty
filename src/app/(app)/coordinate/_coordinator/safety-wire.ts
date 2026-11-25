import { addressValue, pinWire, type AddressValue } from "@/ui/components/address-value";

/** Officer safety addresses between the form and the server. Plain data, no React. */

/** lat and lng: a pin from the address field; null for none without a lookup; left out to look it up on save. */
export type SafetyAddressWire = { address: string; description: string; lat?: number | null; lng?: number | null; source?: "auto" | "manual" };
/** One officer safety address as the form holds it. */
export type SafetyAddressRow = { value: AddressValue; description: string };

export const safetyRows = (list: SafetyAddressWire[]): SafetyAddressRow[] => list.map((a) => ({ value: addressValue(a.address, a.lat, a.lng, a.source ?? "manual"), description: a.description }));

export function safetyWire(rows: SafetyAddressRow[]): SafetyAddressWire[] {
  return rows.map((r) => {
    const pin = pinWire(r.value);
    return { address: r.value.address, description: r.description, ...(pin === undefined ? {} : { lat: pin?.lat ?? null, lng: pin?.lng ?? null, ...(pin ? { source: pin.source } : {}) }) };
  });
}
