import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { jobSafetyAddresses, jobTypes, positionTypes, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ValidationError } from "@/domain/errors";
import { createJob, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { loadSafety, resolveSafetyPins } from "@/domain/jobs/safety";
import { safetyRows, safetyWire } from "@/app/(app)/coordinate/_coordinator/safety-wire";
import { parseJobBody } from "@/app/api/v1/jobs/parse";
import { agencyInstant } from "@/domain/time/agency-time";
import { resetGeocoder } from "@/domain/vendors/geocode";
import { addLocation, updateLocation } from "@/domain/vendors/vendors";

// Fake fetches are async to match fetch; they answer at once.

const nominatim = (lat: string, lon: string) => new Response(JSON.stringify([{ lat, lon }]), { status: 200 });

describe("pins from the address field", () => {
  const get = useTestDb();
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);
  let coord: Actor;
  let vendorId: string;
  let typeId: string;
  let sheriff: string;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coord = (await makeUser(db, "coordinator", "pins@example.test")).actor;
    vendorId = (await db.insert(vendors).values({ name: "Pin Vendor" }).returning())[0].id;
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    sheriff = (await db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff")))[0].id;
  });
  beforeEach(() => {
    resetGeocoder({ intervalMs: 0 });
    fetchMock = vi.fn(() => Promise.resolve(nominatim("41.5", "-90.5")));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("a location saved with a pin from the field stores it and skips the lookup", async () => {
    const auto = await run((tx) => addLocation(coord, tx, vendorId, { name: "Auto", address: "1 Auto St", pin: { lat: 30.1, lng: -86.1, source: "auto" } }));
    expect(auto).toMatchObject({ lat: 30.1, lng: -86.1, geocodeSource: "auto" });
    const manual = await run((tx) => addLocation(coord, tx, vendorId, { name: "Manual", address: "2 Hand St", pin: { lat: 30.2, lng: -86.2, source: "manual" } }));
    expect(manual).toMatchObject({ lat: 30.2, lng: -86.2, geocodeSource: "manual" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a pin of null (no match, or kept as typed) stores no pin and does not look it up", async () => {
    const loc = await run((tx) => addLocation(coord, tx, vendorId, { name: "Kept", address: "3 Typed Way", pin: null }));
    expect(loc).toMatchObject({ lat: null, lng: null });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a dragged pin on an unchanged address is saved as manual; a bad point is refused", async () => {
    const loc = await run((tx) => addLocation(coord, tx, vendorId, { name: "Drag", address: "4 Drag St" }));
    expect(loc).toMatchObject({ lat: 41.5, lng: -90.5, geocodeSource: "auto" });
    const moved = await run((tx) => updateLocation(coord, tx, loc.id, { address: "4 Drag St", pin: { lat: 41.6, lng: -90.4, source: "manual" } }));
    expect(moved).toMatchObject({ lat: 41.6, lng: -90.4, geocodeSource: "manual" });
    await expect(run((tx) => updateLocation(coord, tx, loc.id, { pin: { lat: 91, lng: 0, source: "manual" } }))).rejects.toBeInstanceOf(ValidationError);
  });

  test("a stored safety pin overrides the lookup, and moving it on an existing address updates it", async () => {
    const pins = await resolveSafetyPins({ notes: "", addresses: [{ address: "9 Safety Rd", description: "Dog", lat: 30.5, lng: -86.5 }] });
    expect(fetchMock).not.toHaveBeenCalled();
    const input: JobInput = {
      vendorId,
      locationId: null,
      typeId,
      title: "Pins",
      description: null,
      notes: null,
      startAt: agencyInstant(2035, 8, 1, 17, 0),
      endAt: agencyInstant(2035, 8, 1, 21, 0),
      rateCents: 7000,
      positions: [{ positionTypeId: sheriff, count: 1 }],
      opsPlanRequired: false,
      opsPlanDueAt: null,
      contactName: null,
      contactPhone: null,
      held: false,
      safety: pins,
    };
    const job = await run((tx) => createJob(coord, tx, input));
    await run((tx) => updateJob(coord, tx, job.id, { safety: { notes: "", addresses: [{ address: "9 Safety Rd", description: "Dog", lat: 30.51, lng: -86.49 }] } }, "one"));
    const [row] = await get().db.select().from(jobSafetyAddresses).where(eq(jobSafetyAddresses.jobId, job.id));
    expect(row).toMatchObject({ lat: 30.51, lng: -86.49 });
  });

  const jobWith = (safety: JobInput["safety"]): JobInput => ({
    vendorId,
    locationId: null,
    typeId,
    title: "Safety pins",
    description: null,
    notes: null,
    startAt: agencyInstant(2035, 9, 1, 17, 0),
    endAt: agencyInstant(2035, 9, 1, 21, 0),
    rateCents: 7000,
    positions: [{ positionTypeId: sheriff, count: 1 }],
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: null,
    contactPhone: null,
    held: false,
    safety,
  });
  const stored = async (jobId: string) => (await get().db.select().from(jobSafetyAddresses).where(eq(jobSafetyAddresses.jobId, jobId))).map((r) => ({ address: r.address, lat: r.lat, lng: r.lng, source: r.geocodeSource }));

  test("a hand-placed safety pin survives a REST PATCH that sends no coordinates", async () => {
    const job = await run((tx) => createJob(coord, tx, jobWith({ notes: "", addresses: [{ address: "12 Gate Rd", description: "Dog", lat: 30.11, lng: -86.11, source: "manual" }] })));
    expect(await stored(job.id)).toEqual([{ address: "12 Gate Rd", lat: 30.11, lng: -86.11, source: "manual" }]);
    // The REST body carries the same address with no lat or lng; the lookup answers somewhere else.
    const patch = await parseJobBody(coord, "job.update", { safety: { notes: "Updated", addresses: [{ address: "12 Gate Rd", description: "Dog" }] } });
    await run((tx) => updateJob(coord, tx, job.id, patch, "one"));
    expect(await stored(job.id)).toEqual([{ address: "12 Gate Rd", lat: 30.11, lng: -86.11, source: "manual" }]);
  });

  test("a geocoded safety pin follows a changed address", async () => {
    const pins = await resolveSafetyPins({ notes: "", addresses: [{ address: "1 Old St", description: "" }] });
    const job = await run((tx) => createJob(coord, tx, jobWith(pins)));
    expect(await stored(job.id)).toEqual([{ address: "1 Old St", lat: 41.5, lng: -90.5, source: "auto" }]);
    fetchMock.mockResolvedValueOnce(nominatim("30.3", "-86.3"));
    const patch = await parseJobBody(coord, "job.update", { safety: { notes: "", addresses: [{ address: "2 New St", description: "" }] } });
    await run((tx) => updateJob(coord, tx, job.id, patch, "one"));
    expect(await stored(job.id)).toEqual([{ address: "2 New St", lat: 30.3, lng: -86.3, source: "auto" }]);
  });

  test("the coordinator safety form round-trips each pin's source", async () => {
    const job = await run((tx) =>
      createJob(coord, tx, jobWith({ notes: "", addresses: [{ address: "5 Hand St", description: "", lat: 30.5, lng: -86.5, source: "manual" }, { address: "6 Auto St", description: "", lat: 30.6, lng: -86.6, source: "auto" }] })),
    );
    const view = await run((tx) => loadSafety(tx, job.id));
    const rows = safetyRows(view!.addresses.map((a) => ({ address: a.address, description: a.description ?? "", lat: a.lat, lng: a.lng, source: a.source })));
    expect(rows.map((r) => r.value.pin)).toEqual(["manual", "auto"]);
    const wire = safetyWire(rows);
    expect(wire.map((w) => w.source)).toEqual(["manual", "auto"]);
    await run(async (tx) => updateJob(coord, tx, job.id, { safety: await resolveSafetyPins({ notes: "", addresses: wire }) }, "one"));
    expect(await stored(job.id)).toEqual([
      { address: "5 Hand St", lat: 30.5, lng: -86.5, source: "manual" },
      { address: "6 Auto St", lat: 30.6, lng: -86.6, source: "auto" },
    ]);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
