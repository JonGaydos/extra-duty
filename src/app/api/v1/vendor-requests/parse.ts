import { detailInput, type DetailWire } from "@/app/(app)/coordinate/_coordinator/detail-input";
import { ValidationError } from "@/domain/errors";
import type { TimeOverrides } from "@/domain/jobs/recurrence";
import type { VendorRequestInput } from "@/domain/vendor-portal/requests";

/**
 * A vendor's detail request as the browser sends it: agency dates (YYYY-MM-DD), clock times (HH:MM) and dollars as
 * typed. `dates` lists every date of a request for several dates (the request's own `date` is always one of them).
 */
export type VendorRequestWire = {
  locationId: string;
  /** `pin` from the address field: a point, null for none without a lookup, or left out to look it up. */
  newLocation: { name: string; address: string; pin?: { lat: number; lng: number; source: "auto" | "manual" } | null } | null;
  typeId: string;
  title: string;
  description: string;
  notes: string;
  date: string;
  startTime: string;
  endTime: string;
  dates: string[];
  overrides: TimeOverrides;
  flex: { earliest: string; latest: string; allowShorter: boolean } | null;
  positions: Array<{ positionTypeId: string; count: number }>;
  contactName: string;
  contactPhone: string;
  /** "Add a new contact": saved to the vendor for future details and copied onto the request. */
  newContact?: { name: string; phone: string; email: string } | null;
  rate: string;
  /** A link to a contract; an uploaded file arrives beside the wire instead. */
  contract: { label: string; url: string } | null;
  safetyNotes: string;
  safetyAddresses: Array<{ address: string; description: string; lat?: number | null; lng?: number | null; source?: "auto" | "manual" }>;
};

export type ContractFile = { body: Buffer; filename: string; contentType: string };

const BAD = "The request could not be read. Reload the page and try again.";
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");
/** A coordinate as sent: a number, null, or left out. Anything else is refused later as an invalid pin. */
const coord = (v: unknown): number | null | undefined => (v === null || typeof v === "number" ? v : v === undefined ? undefined : NaN);
const pointOf = (raw: Record<string, unknown>) => {
  const lat = coord(raw.lat);
  const lng = coord(raw.lng);
  return lat === undefined || lng === undefined ? {} : { lat, lng, source: raw.source === "auto" ? ("auto" as const) : ("manual" as const) };
};

/** Checks the shape of the wire and turns it into the service's input, using the coordinator form's time rules. */
export function parseVendorRequest(raw: unknown, file?: ContractFile): VendorRequestInput {
  if (!isObj(raw)) throw new ValidationError(BAD);
  if (!Array.isArray(raw.positions) || !Array.isArray(raw.dates ?? []) || !Array.isArray(raw.safetyAddresses ?? [])) throw new ValidationError(BAD);
  const w = raw as unknown as VendorRequestWire;
  const title = str(w.title).trim();
  if (!title) throw new ValidationError("Give the detail a short title.");
  const positions = w.positions.map((p) => ({ positionTypeId: str(p?.positionTypeId), count: Number(p?.count) }));
  if (positions.some((p) => !Number.isInteger(p.count) || p.count < 1 || p.count > 99)) throw new ValidationError("Enter how many people, from 1 to 99.");

  const date = str(w.date);
  const detail: DetailWire = {
    vendorId: "",
    locationId: str(w.locationId),
    typeId: str(w.typeId),
    title,
    description: str(w.description),
    notes: str(w.notes),
    startTime: str(w.startTime),
    endTime: str(w.endTime),
    rate: str(w.rate),
    positions,
    opsPlanRequired: false,
    contactName: str(w.contactName),
    contactPhone: str(w.contactPhone),
    held: false,
    flex: isObj(w.flex) ? { earliest: str(w.flex.earliest), latest: str(w.flex.latest), allowShorter: w.flex.allowShorter === true } : null,
    safetyNotes: str(w.safetyNotes),
    safetyAddresses: (w.safetyAddresses ?? []).map((a) => ({ address: str(a?.address), description: str(a?.description), ...(isObj(a) ? pointOf(a) : {}) })),
  };
  const job = detailInput(detail, date);

  const all = [...new Set([date, ...(w.dates ?? []).map(str)])].sort();
  const overrides: TimeOverrides = {};
  if (isObj(w.overrides)) {
    for (const [k, o] of Object.entries(w.overrides)) {
      if (!all.includes(k) || !isObj(o)) continue;
      overrides[k] = { ...(o.startTime ? { startTime: str(o.startTime) } : {}), ...(o.endTime ? { endTime: str(o.endTime) } : {}) };
    }
  }

  const label = isObj(w.contract) ? str(w.contract.label).trim() : "";
  const url = isObj(w.contract) ? str(w.contract.url).trim() : "";
  const contract = file ? { label: label || file.filename, file } : url ? { label: label || "Contract", url } : undefined;

  const newContact = isObj(w.newContact) ? { name: str(w.newContact.name), phone: str(w.newContact.phone), email: str(w.newContact.email) } : undefined;
  const rawPin = isObj(w.newLocation) ? w.newLocation.pin : undefined;
  const pin = rawPin === null ? null : isObj(rawPin) ? { lat: Number(rawPin.lat), lng: Number(rawPin.lng), source: rawPin.source === "manual" ? ("manual" as const) : ("auto" as const) } : undefined;
  const newLocation = isObj(w.newLocation) ? { name: str(w.newLocation.name), address: str(w.newLocation.address) || null, ...(pin === undefined ? {} : { pin }) } : undefined;
  return {
    locationId: newLocation ? null : job.locationId,
    ...(newLocation ? { newLocation } : {}),
    typeId: job.typeId,
    title: job.title,
    description: job.description,
    notes: job.notes,
    startAt: job.startAt,
    endAt: job.endAt,
    rateCents: job.rateCents,
    positions: job.positions,
    flex: job.flex,
    safety: job.safety,
    contactName: job.contactName,
    contactPhone: job.contactPhone,
    ...(newContact ? { newContact } : {}),
    ...(contract ? { contract } : {}),
    ...(all.length > 1 ? { dates: { kind: "dates" as const, dates: all }, overrides } : {}),
  };
}
