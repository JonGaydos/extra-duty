import { describe, expect, test } from "vitest";
import { parseVendorRequest, type VendorRequestWire } from "@/app/api/v1/vendor-requests/parse";
import { ValidationError } from "@/domain/errors";
import { agencyInstant } from "@/domain/time/agency-time";

const wire = (over: Partial<VendorRequestWire> = {}): VendorRequestWire => ({
  locationId: "loc-1",
  newLocation: null,
  typeId: "type-1",
  title: " Summer concerts ",
  description: "Lawn crowd",
  notes: "",
  date: "2026-12-05",
  startTime: "18:00",
  endTime: "22:00",
  dates: [],
  overrides: {},
  flex: null,
  positions: [{ positionTypeId: "pos-1", count: 2 }],
  contactName: "Events office",
  contactPhone: "850-555-0142",
  rate: "",
  contract: null,
  safetyNotes: "",
  safetyAddresses: [],
  ...over,
});

describe("vendor request wire", () => {
  test("one date becomes a single request with agency times", () => {
    const r = parseVendorRequest(wire());
    expect(r).toMatchObject({ locationId: "loc-1", typeId: "type-1", title: "Summer concerts", startAt: agencyInstant(2026, 12, 5, 18, 0), endAt: agencyInstant(2026, 12, 5, 22, 0), positions: [{ positionTypeId: "pos-1", count: 2 }] });
    expect(r.dates).toBeUndefined();
    expect(r.flex).toBeNull();
    expect(r.safety).toBeUndefined();
    expect(r.rateCents).toBeNull();
  });

  test("several dates, a per-date time change and flexible times use the coordinator form's rules", () => {
    const r = parseVendorRequest(
      wire({
        dates: ["2026-12-12", "2026-12-05", "2026-12-19", "2026-12-12"],
        overrides: { "2026-12-12": { startTime: "17:00", endTime: "21:00" }, "2027-01-01": { startTime: "09:00" } },
        flex: { earliest: "17:30", latest: "22:30", allowShorter: true },
      }),
    );
    expect(r.dates).toEqual({ kind: "dates", dates: ["2026-12-05", "2026-12-12", "2026-12-19"] });
    expect(r.overrides).toEqual({ "2026-12-12": { startTime: "17:00", endTime: "21:00" } });
    expect(r.flex).toEqual({ earliestStartAt: agencyInstant(2026, 12, 5, 17, 30), latestEndAt: agencyInstant(2026, 12, 5, 22, 30), allowShorter: true });
  });

  test("the request's own date is always one of the dates", () => {
    expect(parseVendorRequest(wire({ dates: ["2026-12-12"] })).dates).toEqual({ kind: "dates", dates: ["2026-12-05", "2026-12-12"] });
  });

  test("officer safety keeps notes and the addresses that were filled in", () => {
    const r = parseVendorRequest(wire({ safetyNotes: "Prior threats at the gate", safetyAddresses: [{ address: "12 Gate Rd", description: "Former employee" }, { address: " ", description: "" }] }));
    expect(r.safety).toEqual({ notes: "Prior threats at the gate", addresses: [{ address: "12 Gate Rd", description: "Former employee" }] });
  });

  test("a contract is a file or a link", () => {
    const file = { body: Buffer.from("%PDF-1.4"), filename: "contract.pdf", contentType: "application/pdf" };
    expect(parseVendorRequest(wire({ contract: { label: "", url: "" } }), file).contract).toEqual({ label: "contract.pdf", file });
    expect(parseVendorRequest(wire({ contract: { label: "Signed", url: "https://sign.example/x" } })).contract).toEqual({ label: "Signed", url: "https://sign.example/x" });
    expect(parseVendorRequest(wire({ contract: { label: "", url: "" } })).contract).toBeUndefined();
  });

  test("a new location replaces the picked one", () => {
    const r = parseVendorRequest(wire({ newLocation: { name: "North lot", address: "1 Main St" } }));
    expect(r.locationId).toBeNull();
    expect(r.newLocation).toEqual({ name: "North lot", address: "1 Main St" });
  });

  test("malformed bodies and counts are refused", () => {
    expect(() => parseVendorRequest(null)).toThrow(ValidationError);
    expect(() => parseVendorRequest({ ...wire(), positions: "two" })).toThrow(ValidationError);
    expect(() => parseVendorRequest(wire({ positions: [{ positionTypeId: "pos-1", count: 0 }] }))).toThrow("Enter how many people, from 1 to 99.");
    expect(() => parseVendorRequest(wire({ title: "  " }))).toThrow("Give the detail a short title.");
    expect(() => parseVendorRequest(wire({ startTime: "6 PM" }))).toThrow(ValidationError);
  });
});
