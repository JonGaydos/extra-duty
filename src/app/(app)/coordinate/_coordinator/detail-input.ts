import { ValidationError } from "@/domain/errors";
import type { JobInput } from "@/domain/jobs/jobs";
import { addDays } from "@/domain/jobs/recurrence";
import { agencyInstant } from "@/domain/time/agency-time";
import type { Cents } from "@/domain/types";

/** "Add a new contact" on a detail form: saved to the vendor, then copied onto the detail. */
export type NewContactWire = { name: string; phone: string; email: string };

/** The detail form as the browser sends it: agency dates (YYYY-MM-DD), clock times (HH:MM) and dollars as typed. */
export type DetailWire = {
  vendorId: string;
  locationId: string;
  typeId: string;
  title: string;
  description: string;
  notes: string;
  startTime: string;
  endTime: string;
  rate: string;
  positions: Array<{ positionTypeId: string; count: number }>;
  opsPlanRequired: boolean;
  contactName: string;
  contactPhone: string;
  newContact?: NewContactWire | null;
  held: boolean;
  flex: { earliest: string; latest: string; allowShorter: boolean } | null;
  safetyNotes: string;
  /** lat and lng: the address field's pin; null for none without a lookup; left out to look it up on save. */
  safetyAddresses: Array<{ address: string; description: string; lat?: number | null; lng?: number | null; source?: "auto" | "manual" }>;
  /** Approval reason when the rate is outside the agency range (one detail only). */
  rateOverrideReason?: string;
};

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

/** An agency wall-clock instant on a calendar day. Never UTC midnight. */
export function onDay(date: string, time: string, label: string): Date {
  const d = DATE.exec(date ?? "");
  const t = TIME.exec(time ?? "");
  if (!d) throw new ValidationError(`Choose a date for ${label.toLowerCase()}.`);
  if (!t) throw new ValidationError(`${label} needs a time.`);
  return agencyInstant(Number(d[1]), Number(d[2]), Number(d[3]), Number(t[1]), Number(t[2]));
}

/** Dollars as typed ("70" or "72.50") to cents; blank means the vendor's default rate. */
export function parseDollars(v: string, label: string): Cents | null {
  const t = (v ?? "").replace(/[$,\s]/g, "");
  if (t === "") return null;
  if (!/^\d{1,5}(\.\d{1,2})?$/.test(t)) throw new ValidationError(`Enter ${label.toLowerCase()} in dollars, such as 70 or 72.50.`);
  const [whole, cents = ""] = t.split(".");
  return Number(whole) * 100 + Number(cents.padEnd(2, "0"));
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Start and end on `date`; an end before the start ends the next day, and an equal end makes a 24-hour detail. */
export function spanOn(date: string, startTime: string, endTime: string): { startAt: Date; endAt: Date } {
  const startAt = onDay(date, startTime, "Start time");
  if (!TIME.test(endTime ?? "")) throw new ValidationError("End time needs a time.");
  const endDate = minutesOf(endTime) <= minutesOf(startTime) ? addDays(date, 1) : date;
  return { startAt, endAt: onDay(endDate, endTime, "End time") };
}

/**
 * A changed time on one date of the bulk dates preview. Equal times there are refused: a per-date change to the
 * same clock time is almost always a slip, and a 24-hour detail is set on the form itself.
 */
export function overrideSpanOn(date: string, startTime: string, endTime: string): { startAt: Date; endAt: Date } {
  if (endTime === startTime) throw new ValidationError("The end time must differ from the start time.");
  return spanOn(date, startTime, endTime);
}

/** The form's fields as a JobInput anchored on `date`. Safety pins are looked up by the caller, outside any transaction. */
export function detailInput(w: DetailWire, date: string): JobInput {
  const { startAt, endAt } = spanOn(date, w.startTime, w.endTime);
  let flex: JobInput["flex"] = null;
  if (w.flex) {
    if (!TIME.test(w.flex.earliest) || !TIME.test(w.flex.latest)) throw new ValidationError("Flexible times need an earliest start and a latest finish.");
    const earliestDate = minutesOf(w.flex.earliest) > minutesOf(w.startTime) ? addDays(date, -1) : date;
    const endDate = minutesOf(w.endTime) <= minutesOf(w.startTime) ? addDays(date, 1) : date;
    const latestDate = minutesOf(w.flex.latest) < minutesOf(w.endTime) ? addDays(endDate, 1) : endDate;
    flex = { earliestStartAt: onDay(earliestDate, w.flex.earliest, "Earliest start"), latestEndAt: onDay(latestDate, w.flex.latest, "Latest finish"), allowShorter: w.flex.allowShorter };
  }
  const addresses = w.safetyAddresses.filter((a) => a.address.trim());
  return {
    vendorId: w.vendorId,
    locationId: w.locationId || null,
    typeId: w.typeId,
    title: w.title,
    description: w.description,
    notes: w.notes,
    startAt,
    endAt,
    rateCents: parseDollars(w.rate, "The rate"),
    rateOverrideReason: w.rateOverrideReason?.trim() || null,
    positions: w.positions.map((p) => ({ positionTypeId: p.positionTypeId, count: Number(p.count) })),
    opsPlanRequired: w.opsPlanRequired,
    opsPlanDueAt: null,
    contactName: w.contactName,
    contactPhone: w.contactPhone,
    held: w.held,
    flex,
    safety: w.safetyNotes.trim() || addresses.length ? { notes: w.safetyNotes, addresses: addresses.map((a) => ({ address: a.address, description: a.description, ...(a.lat !== undefined && a.lng !== undefined ? { lat: a.lat, lng: a.lng, source: a.source === "auto" ? ("auto" as const) : ("manual" as const) } : {}) })) } : undefined,
  };
}
