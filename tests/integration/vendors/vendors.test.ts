import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { files, jobTypes, jobs, vendorDocuments, vendorHolds, vendorLocations, vendorTypes, vendorUsers, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { listAudit } from "@/domain/audit/audit";
import { loadActiveActor } from "@/domain/auth/sign-in-policy";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { geocodeAddress, resetGeocoder } from "@/domain/vendors/geocode";
import {
  addLocation,
  addVendorDocument,
  contractExpiryTick,
  createVendor,
  createVendorLogin,
  listLocations,
  listVendorDocuments,
  listVendors,
  placePaymentHold,
  resolvePaymentHold,
  setLocationActive,
  setLocationPin,
  setVendorActive,
  updateLocation,
  updateVendor,
  vendorHasCurrentContract,
} from "@/domain/vendors/vendors";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { useEmailQueue } from "../../setup/email-queue";
import { byText } from "@/lib/sort";

// Fake fetches are async to match fetch; they answer at once.

const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("contract ".repeat(20))]);
const input = (name: string) => ({ name, typeId: null, contactName: "Pat", phone: "850-555-0155", billingEmails: ["Bill@Example.test"], defaultRateCents: 4500, notes: null });
const nominatim = (lat: string, lon: string) => new Response(JSON.stringify([{ lat, lon }]), { status: 200 });

describe("vendors", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let coordinator: Actor;
  let admin: Actor;
  let personnel: Actor;
  let vendorA: string;
  let vendorB: string;
  let vendorUserA: Actor;
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-vendors-"));
    setEmailSender(mail);
    coordinator = (await makeUser(db, "coordinator", "coord@example.test")).actor;
    admin = (await makeUser(db, "admin", "admin@example.test")).actor;
    personnel = (await makeUser(db, "personnel", "pers@example.test")).actor;
    await db.transaction(async (tx) => {
      vendorA = (await createVendor(coordinator, tx, input("Alpha Stadium"))).id;
      vendorB = (await createVendor(coordinator, tx, input("Beta Arena"))).id;
    });
    await db.transaction(async (tx) => {
      const u = await createVendorLogin(coordinator, tx, vendorA, { email: "a.user@example.test", name: "A User" });
      vendorUserA = (await loadActiveActor(tx, u.id))!;
    });
  });

  beforeEach(() => {
    resetGeocoder({ intervalMs: 0 });
    fetchMock = vi.fn(() => Promise.resolve(nominatim("41.5", "-90.5")));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("personnel cannot create vendors; coordinators can", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => createVendor(personnel, tx, input("X")))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => createVendor(vendorUserA, tx, input("X")))).rejects.toBeInstanceOf(ForbiddenError);
    const v = await db.transaction((tx) => createVendor(admin, tx, input("Gamma Fair")));
    expect(v.billingEmails).toEqual(["bill@example.test"]);
    expect(v.active).toBe(true);
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: v.id }, 1));
    expect(audit.map((a) => a.action)).toEqual(["vendor.create"]);
  });

  test("billing emails, rate, name and type are validated", async () => {
    const { db } = get();
    for (const bad of [
      { ...input("V"), billingEmails: ["not-an-email"] },
      { ...input("V"), defaultRateCents: 45.5 },
      { ...input("V"), defaultRateCents: -1 },
      { ...input("  ") },
      { ...input("V"), typeId: "missing" },
    ]) {
      await expect(db.transaction((tx) => createVendor(coordinator, tx, bad))).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(db.transaction((tx) => updateVendor(coordinator, tx, vendorA, { billingEmails: ["a@b.test", "nope"] }))).rejects.toBeInstanceOf(ValidationError);
  });

  test("updateVendor and setVendorActive change and audit", async () => {
    const { db } = get();
    const [t] = await db.insert(vendorTypes).values({ name: "Venue" }).returning();
    const v = await db.transaction((tx) => createVendor(coordinator, tx, input("Delta")));
    const u = await db.transaction((tx) => updateVendor(coordinator, tx, v.id, { name: " Delta Park ", typeId: t.id, defaultRateCents: null }));
    expect(u).toMatchObject({ name: "Delta Park", typeId: t.id, defaultRateCents: null });
    const off = await db.transaction((tx) => setVendorActive(coordinator, tx, v.id, false));
    expect(off.active).toBe(false);
    await expect(db.transaction((tx) => setVendorActive(personnel, tx, v.id, true))).rejects.toBeInstanceOf(ForbiddenError);
    const audit = await db.transaction((tx) => listAudit(coordinator, tx, { entityId: v.id }, 1));
    expect(audit.map((a) => a.action).sort(byText)).toEqual(["vendor.create", "vendor.deactivate", "vendor.update"]);
  });

  test("updateVendor checks each field it is given, in order, and saves the invoice options", async () => {
    const { db } = get();
    const v = await db.transaction((tx) => createVendor(coordinator, tx, input("Echo")));
    const update = (patch: Record<string, unknown>) => db.transaction((tx) => updateVendor(coordinator, tx, v.id, patch as never));
    await expect(update({ name: "  " })).rejects.toThrow("Vendor name is required.");
    await expect(update({ name: "  ", invoiceSendSchedule: "never" })).rejects.toThrow("Vendor name is required.");
    await expect(update({ invoiceSendSchedule: "never", emailApprovedInvoices: "yes" })).rejects.toThrow("Choose when invoices are sent.");
    await expect(update({ emailApprovedInvoices: "yes" })).rejects.toThrow("Choose whether approved invoices are emailed to this vendor.");
    expect(await update({})).toMatchObject({ id: v.id, name: "Echo" });
    expect(await update({ invoiceSendSchedule: null, emailApprovedInvoices: false })).toMatchObject({ invoiceSendSchedule: null, emailApprovedInvoices: false });
  });

  test("createVendorLogin makes a vendor user whose actor has vendorId, and invites", async () => {
    const { db } = get();
    await drain();
    mail.clear();
    const u = await db.transaction((tx) => createVendorLogin(coordinator, tx, vendorB, { email: "B.User@Example.test", name: "B User" }));
    expect(u).toMatchObject({ email: "b.user@example.test", role: "vendor" });
    expect(mail.sent).toHaveLength(0);
    await drain();
    expect(mail.sent).toHaveLength(1);
    const actor = await db.transaction((tx) => loadActiveActor(tx, u.id));
    expect(actor).toMatchObject({ role: "vendor", vendorId: vendorB });
    expect(vendorUserA.vendorId).toBe(vendorA);
    await expect(db.transaction((tx) => createVendorLogin(coordinator, tx, vendorB, { email: "b.user@example.test", name: "x" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => createVendorLogin(personnel, tx, vendorB, { email: "z@example.test", name: "z" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.select().from(vendorUsers).where(eq(vendorUsers.userId, u.id))).toHaveLength(1);
    expect(await db.select({ id: users.id }).from(users).where(eq(users.email, "z@example.test"))).toHaveLength(0);
  });

  test("a vendor actor lists only their own vendor; personnel are refused", async () => {
    const { db } = get();
    const mine = await db.transaction((tx) => listVendors(vendorUserA, tx, {}));
    expect(mine.map((v) => v.id)).toEqual([vendorA]);
    expect((await db.transaction((tx) => listVendors(coordinator, tx, {}))).length).toBeGreaterThan(2);
    await expect(db.transaction((tx) => listVendors(personnel, tx, {}))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("adding a location stores the geocoded pin with a generic User-Agent", async () => {
    const { db } = get();
    const loc = await db.transaction((tx) => addLocation(coordinator, tx, vendorA, { name: "Main gate", address: "1 Main St, Davenport, IA" }));
    expect(loc).toMatchObject({ lat: 41.5, lng: -90.5, geocodeSource: "auto", active: true });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("https://nominatim.openstreetmap.org/search");
    expect((init.headers as Record<string, string>)["User-Agent"]).toBe("Signal90/1.0");
  });

  test("a geocoder failure still saves the location with no pin", async () => {
    const { db } = get();
    fetchMock.mockRejectedValueOnce(new Error("network down"));
    const a = await db.transaction((tx) => addLocation(coordinator, tx, vendorA, { name: "Back lot", address: "2 Unknown Rd" }));
    expect(a).toMatchObject({ lat: null, lng: null });
    fetchMock.mockResolvedValueOnce(new Response("oops", { status: 503 }));
    const b = await db.transaction((tx) => addLocation(coordinator, tx, vendorA, { name: "Side lot", address: "3 Unknown Rd" }));
    expect(b.lat).toBeNull();
    fetchMock.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const c = await db.transaction((tx) => addLocation(coordinator, tx, vendorA, { name: "No match", address: "4 Nowhere" }));
    expect(c.lat).toBeNull();
  });

  test("geocodeAddress caches results and spaces requests at least the interval apart", async () => {
    resetGeocoder({ intervalMs: 60 });
    expect(await geocodeAddress("10 Cache St")).toEqual({ lat: 41.5, lng: -90.5 });
    expect(await geocodeAddress("  10  cache st ")).toEqual({ lat: 41.5, lng: -90.5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const starts: number[] = [];
    fetchMock.mockImplementation(() => {
      starts.push(Date.now());
      return Promise.resolve(nominatim("1", "2"));
    });
    await Promise.all([geocodeAddress("A St"), geocodeAddress("B St"), geocodeAddress("C St")]);
    expect(starts).toHaveLength(3);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(55);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(55);
  });

  test("a hung geocoder times out and returns null", async () => {
    vi.useFakeTimers();
    try {
      fetchMock.mockImplementation((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener("abort", () => rej(new Error("aborted")))));
      const p = geocodeAddress("Slow St");
      await vi.advanceTimersByTimeAsync(5001);
      expect(await p).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  test("a vendor user adds and edits their own locations, and gets NotFound for another vendor's", async () => {
    const { db } = get();
    const mine = await db.transaction((tx) => addLocation(vendorUserA, tx, vendorA, { name: "North gate", address: "5 North St" }));
    const edited = await db.transaction((tx) => updateLocation(vendorUserA, tx, mine.id, { name: "North entrance", address: "6 North St" }));
    expect(edited).toMatchObject({ name: "North entrance", address: "6 North St" });
    const pinned = await db.transaction((tx) => setLocationPin(vendorUserA, tx, mine.id, { lat: 40, lng: -91 }));
    expect(pinned).toMatchObject({ lat: 40, lng: -91, geocodeSource: "manual" });
    await expect(db.transaction((tx) => setLocationPin(vendorUserA, tx, mine.id, { lat: 100, lng: 0 }))).rejects.toBeInstanceOf(ValidationError);

    await expect(db.transaction((tx) => addLocation(vendorUserA, tx, vendorB, { name: "x", address: null }))).rejects.toBeInstanceOf(NotFoundError);
    const [theirs] = await db.insert(vendorLocations).values({ vendorId: vendorB, name: "B gate" }).returning();
    await expect(db.transaction((tx) => updateLocation(vendorUserA, tx, theirs.id, { name: "hacked" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.transaction((tx) => setLocationActive(vendorUserA, tx, theirs.id, false))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.transaction((tx) => listLocations(vendorUserA, tx, vendorB))).rejects.toBeInstanceOf(NotFoundError);
    await expect(db.transaction((tx) => addLocation(personnel, tx, vendorA, { name: "x", address: null }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a changed address is regeocoded and replaces a manual pin", async () => {
    const { db } = get();
    const loc = await db.transaction((tx) => addLocation(coordinator, tx, vendorA, { name: "Pin test", address: "7 First St" }));
    await db.transaction((tx) => setLocationPin(coordinator, tx, loc.id, { lat: 1, lng: 2 }));
    fetchMock.mockResolvedValueOnce(nominatim("30", "-80"));
    const moved = await db.transaction((tx) => updateLocation(coordinator, tx, loc.id, { address: "8 Second St" }));
    expect(moved).toMatchObject({ lat: 30, lng: -80, geocodeSource: "auto" });
    const renamed = await db.transaction((tx) => updateLocation(coordinator, tx, loc.id, { name: "Renamed" }));
    expect(renamed).toMatchObject({ lat: 30, lng: -80 });
  });

  test("a location used by a job is deactivated, never deleted, and no longer offered", async () => {
    const { db } = get();
    const loc = await db.transaction((tx) => addLocation(coordinator, tx, vendorA, { name: "Used lot", address: null }));
    const [jt] = await db.insert(jobTypes).values({ name: "Event" }).returning();
    const [job] = await db
      .insert(jobs)
      .values({ vendorId: vendorA, locationId: loc.id, typeId: jt.id, title: "Game", startAt: new Date(), endAt: new Date(Date.now() + 3_600_000), rateCents: 4000 })
      .returning();
    const off = await db.transaction((tx) => setLocationActive(coordinator, tx, loc.id, false));
    expect(off.active).toBe(false);
    const offered = await db.transaction((tx) => listLocations(coordinator, tx, vendorA));
    expect(offered.map((l) => l.id)).not.toContain(loc.id);
    const all = await db.transaction((tx) => listLocations(coordinator, tx, vendorA, { includeInactive: true }));
    expect(all.map((l) => l.id)).toContain(loc.id);
    const [j] = await db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(j.locationId).toBe(loc.id);
    await db.transaction((tx) => setLocationActive(coordinator, tx, loc.id, true));
    expect((await db.transaction((tx) => listLocations(vendorUserA, tx, vendorA))).map((l) => l.id)).toContain(loc.id);
  });

  test("payment hold: personnel and vendors are refused; place and resolve keep history", async () => {
    const { db } = get();
    await expect(db.transaction((tx) => placePaymentHold(personnel, tx, vendorA, "late"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => placePaymentHold(vendorUserA, tx, vendorA, "late"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => placePaymentHold(coordinator, tx, vendorA, "  "))).rejects.toBeInstanceOf(ValidationError);
    const held = await db.transaction((tx) => placePaymentHold(coordinator, tx, vendorA, "Unpaid invoices"));
    expect(held).toMatchObject({ paymentHold: true, paymentHoldReason: "Unpaid invoices" });
    await expect(db.transaction((tx) => placePaymentHold(coordinator, tx, vendorA, "again"))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => resolvePaymentHold(personnel, tx, vendorA, { outcome: "handled" }))).rejects.toBeInstanceOf(ForbiddenError);
    const cleared = await db.transaction((tx) => resolvePaymentHold(admin, tx, vendorA, { outcome: "fix_coming", note: "Check mailed" }));
    expect(cleared).toMatchObject({ paymentHold: false, paymentHoldReason: null });
    await expect(db.transaction((tx) => resolvePaymentHold(coordinator, tx, vendorA, { outcome: "handled" }))).rejects.toBeInstanceOf(ValidationError);
    const [h] = await db.select().from(vendorHolds).where(eq(vendorHolds.vendorId, vendorA));
    expect(h).toMatchObject({ reason: "Unpaid invoices", outcome: "fix_coming", note: "Check mailed", placedBy: coordinator.userId, resolvedBy: admin.userId });
    expect(h.resolvedAt).toBeInstanceOf(Date);
    await db.transaction((tx) => placePaymentHold(coordinator, tx, vendorA, "Second hold"));
    await db.transaction((tx) => resolvePaymentHold(coordinator, tx, vendorA, { outcome: "handled" }));
    expect(await db.select().from(vendorHolds).where(eq(vendorHolds.vendorId, vendorA))).toHaveLength(2);
  });

  test("a vendor with no contract is saved; documents validate file xor https url", async () => {
    const { db } = get();
    const v = await db.transaction((tx) => createVendor(coordinator, tx, input("No Contract Co")));
    expect(await db.transaction((tx) => vendorHasCurrentContract(tx, v.id, "2026-11-22"))).toBe(false);
    const base = { kind: "contract" as const, label: "Agreement" };
    await expect(db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, { ...base, file: PDF, filename: "c.pdf", contentType: "application/pdf", url: "https://x.test/c" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, base))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, { ...base, url: "http://x.test/c" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, { ...base, url: "not a url" }))).rejects.toBeInstanceOf(ValidationError);
    await expect(db.transaction((tx) => addVendorDocument(personnel, tx, v.id, { ...base, url: "https://x.test/c" }))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await db.select().from(vendorDocuments).where(eq(vendorDocuments.vendorId, v.id))).toHaveLength(0);

    const doc = await db.transaction((tx) =>
      addVendorDocument(coordinator, tx, v.id, { ...base, file: PDF, filename: "c.pdf", contentType: "application/pdf", signedOn: new Date("2026-01-10T18:00:00Z"), expiresOn: new Date("2027-01-10T18:00:00Z") }),
    );
    expect(doc).toMatchObject({ signedOn: "2026-01-10", expiresOn: "2027-01-10", url: null });
    const [f] = await db.select().from(files).where(eq(files.id, doc.fileId!));
    expect(f).toMatchObject({ kind: "contract", encrypted: false });
    await expect(db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, { ...base, url: "https://x.test/c", signedOn: new Date("2026-05-01T18:00:00Z"), expiresOn: new Date("2026-04-01T18:00:00Z") }))).rejects.toBeInstanceOf(ValidationError);
    const link = await db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, { kind: "other", label: "Insurance", url: "https://x.test/ins" }));
    expect(link).toMatchObject({ fileId: null, url: "https://x.test/ins", kind: "other" });
  });

  test("vendorHasCurrentContract respects signed and expiry dates and kind", async () => {
    const { db } = get();
    const v = await db.transaction((tx) => createVendor(coordinator, tx, input("Dates Co")));
    const has = (d: string) => db.transaction((tx) => vendorHasCurrentContract(tx, v.id, d));
    await db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, { kind: "other", label: "Insurance", url: "https://x.test/i" }));
    expect(await has("2026-11-22")).toBe(false);
    await db.transaction((tx) =>
      addVendorDocument(coordinator, tx, v.id, { kind: "contract", label: "C", url: "https://x.test/c", signedOn: new Date("2026-06-01T18:00:00Z"), expiresOn: new Date("2026-12-01T18:00:00Z") }),
    );
    expect(await has("2026-05-31")).toBe(false);
    expect(await has("2026-06-01")).toBe(true);
    expect(await has("2026-12-01")).toBe(true);
    expect(await has("2026-12-02")).toBe(false);
    await db.transaction((tx) => addVendorDocument(coordinator, tx, v.id, { kind: "contract", label: "Open ended", url: "https://x.test/c2" }));
    expect(await has("2030-01-01")).toBe(true);
  });

  test("only coordinators, admins and that vendor list vendor documents", async () => {
    const { db } = get();
    await db.transaction((tx) => addVendorDocument(coordinator, tx, vendorA, { kind: "contract", label: "A contract", url: "https://x.test/a" }));
    expect((await db.transaction((tx) => listVendorDocuments(vendorUserA, tx, vendorA))).length).toBeGreaterThan(0);
    expect((await db.transaction((tx) => listVendorDocuments(admin, tx, vendorA))).length).toBeGreaterThan(0);
    await expect(db.transaction((tx) => listVendorDocuments(personnel, tx, vendorA))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(db.transaction((tx) => listVendorDocuments(vendorUserA, tx, vendorB))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("contract expiry reminders come once at 60 days and once at 30 days", async () => {
    const { db } = get();
    const v = await db.transaction((tx) => createVendor(coordinator, tx, input("Expiring Co")));
    const doc = await db.transaction((tx) =>
      addVendorDocument(coordinator, tx, v.id, { kind: "contract", label: "Exp", url: "https://x.test/e", expiresOn: new Date("2027-03-01T18:00:00Z") }),
    );
    const tick = (iso: string) => db.transaction((tx) => contractExpiryTick(tx, new Date(iso))).then((r) => r.filter((x) => x.documentId === doc.id));
    expect(await tick("2026-12-30T18:00:00Z")).toEqual([]); // 61 days
    const at60 = await tick("2026-12-31T18:00:00Z"); // 60 days
    expect(at60).toMatchObject([{ vendorId: v.id, vendorName: "Expiring Co", expiresOn: "2027-03-01", daysBefore: 60 }]);
    expect(await tick("2026-12-31T20:00:00Z")).toEqual([]);
    expect(await tick("2027-01-15T18:00:00Z")).toEqual([]); // 45 days
    expect(await tick("2027-01-30T18:00:00Z")).toMatchObject([{ daysBefore: 30 }]); // 30 days
    expect(await tick("2027-01-31T18:00:00Z")).toEqual([]);
    expect(await tick("2027-03-02T18:00:00Z")).toEqual([]); // expired
  });

  test("a contract first seen inside 30 days gets only the 30 day reminder; inactive vendors are skipped", async () => {
    const { db } = get();
    const v = await db.transaction((tx) => createVendor(coordinator, tx, input("Late Co")));
    const w = await db.transaction((tx) => createVendor(coordinator, tx, input("Off Co")));
    const mk = (id: string) => db.transaction((tx) => addVendorDocument(coordinator, tx, id, { kind: "contract", label: "L", url: "https://x.test/l", expiresOn: new Date("2028-03-01T18:00:00Z") }));
    const d = await mk(v.id);
    const e = await mk(w.id);
    await db.transaction((tx) => setVendorActive(coordinator, tx, w.id, false));
    const r = await db.transaction((tx) => contractExpiryTick(tx, new Date("2028-02-15T18:00:00Z")));
    expect(r.filter((x) => [d.id, e.id].includes(x.documentId))).toMatchObject([{ documentId: d.id, daysBefore: 30 }]);
    expect((await db.transaction((tx) => contractExpiryTick(tx, new Date("2028-02-16T18:00:00Z")))).filter((x) => x.documentId === d.id)).toEqual([]);
  });
});
