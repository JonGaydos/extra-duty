import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import type { Tx } from "@/db/client";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { auditLog, jobTypes, jobs, vendorContacts, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { createJob, type JobInput } from "@/domain/jobs/jobs";
import { updateSettings } from "@/domain/settings/settings";
import { submitRequest } from "@/domain/vendor-portal/requests";
import { resetGeocoder } from "@/domain/vendors/geocode";
import { addVendorContact, listVendorContacts, setVendorContactActive, updateVendorContact } from "@/domain/vendors/contacts";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";
import { byText } from "@/lib/sort";

// Fake fetches are async to match fetch; they answer at once.

const HOUR = 3_600_000;

describe("vendor site contacts", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let personnel: Actor;
  let vendorUser: Actor;
  let otherVendorUser: Actor;
  let typeId: string;

  const run = <T>(fn: (tx: Tx) => Promise<T>) => get().db.transaction(fn);
  const auditActions = async (id: string) => (await get().db.select().from(auditLog).where(eq(auditLog.entityId, id))).map((a) => a.action).sort(byText);

  beforeAll(async () => {
    const { db } = get();
    setEmailSender(createMemorySender());
    fx = await setupFixture(db, "vc");
    admin = (await makeUser(db, "admin", "vc-admin@example.test")).actor;
    personnel = await fx.person();
    const made = await makeUser(db, "vendor", "vc-vendor@example.test");
    vendorUser = { ...made.actor, vendorId: fx.vendorId };
    await db.insert(vendorUsers).values({ userId: made.row.id, vendorId: fx.vendorId });
    const other = await makeUser(db, "vendor", "vc-vendor-other@example.test");
    otherVendorUser = { ...other.actor, vendorId: fx.otherVendorId };
    await db.insert(vendorUsers).values({ userId: other.row.id, vendorId: fx.otherVendorId });
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    await run((tx) => updateSettings(admin, tx, { defaultPositionTypeId: fx.pos["Deputy Sheriff"], vendorMinNoticeHours: 1 }));
  });

  beforeEach(() => {
    resetGeocoder({ intervalMs: 0 });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(new Response("[]", { status: 200 }))));
  });
  afterEach(() => vi.unstubAllGlobals());

  test("a coordinator adds, edits and deactivates a contact; each write is audited and nothing is deleted", async () => {
    const c = await run((tx) => addVendorContact(fx.coord, tx, fx.vendorId, { name: "  Dana Gate ", phone: "(850) 555-0101", email: " Dana@Vendor.example ", notes: "North gate" }));
    expect(c).toMatchObject({ vendorId: fx.vendorId, name: "Dana Gate", phone: "850-555-0101", email: "dana@vendor.example", notes: "North gate", active: true });
    const u = await run((tx) => updateVendorContact(admin, tx, c.id, { phone: "8505550199", notes: "" }));
    expect(u).toMatchObject({ phone: "850-555-0199", notes: null });
    const off = await run((tx) => setVendorContactActive(fx.coord, tx, c.id, false));
    expect(off.active).toBe(false);
    expect(await get().db.select().from(vendorContacts).where(eq(vendorContacts.id, c.id))).toHaveLength(1);
    expect(await auditActions(c.id)).toEqual(["vendor_contact.create", "vendor_contact.deactivate", "vendor_contact.update"]);

    const active = await run((tx) => listVendorContacts(fx.coord, tx, fx.vendorId));
    expect(active.map((x) => x.id)).not.toContain(c.id);
    const all = await run((tx) => listVendorContacts(fx.coord, tx, fx.vendorId, { includeInactive: true }));
    expect(all.map((x) => x.id)).toContain(c.id);
  });

  test("the name needs a letter, the phone 10 US digits and the email a valid address", async () => {
    for (const bad of [
      { name: "123", phone: "850-555-0101" },
      { name: "", phone: "850-555-0101" },
      { name: "Sam", phone: "555-0101" },
      { name: "Sam", phone: "" },
      { name: "Sam", phone: "850-555-0101", email: "not-an-email" },
    ]) {
      await expect(run((tx) => addVendorContact(fx.coord, tx, fx.vendorId, bad))).rejects.toBeInstanceOf(ValidationError);
    }
  });

  test("an unchanged phone saved before the rule is kept when another field changes", async () => {
    const [old] = await get().db.insert(vendorContacts).values({ vendorId: fx.vendorId, name: "Legacy", phone: "555-0100" }).returning();
    const u = await run((tx) => updateVendorContact(fx.coord, tx, old.id, { name: "Legacy Desk", phone: "555-0100" }));
    expect(u).toMatchObject({ name: "Legacy Desk", phone: "555-0100" });
  });

  test("a vendor manages only its own contacts; another vendor's contact is not found", async () => {
    const mine = await run((tx) => addVendorContact(vendorUser, tx, fx.vendorId, { name: "Pat Usher", phone: "850-555-0102" }));
    const theirs = await run((tx) => addVendorContact(otherVendorUser, tx, fx.otherVendorId, { name: "Other Desk", phone: "850-555-0103" }));
    await run((tx) => updateVendorContact(vendorUser, tx, mine.id, { notes: "Front desk" }));

    await expect(run((tx) => updateVendorContact(vendorUser, tx, theirs.id, { name: "Taken" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => setVendorContactActive(vendorUser, tx, theirs.id, false))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => addVendorContact(vendorUser, tx, fx.otherVendorId, { name: "Sneak", phone: "850-555-0104" }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(run((tx) => listVendorContacts(vendorUser, tx, fx.otherVendorId))).rejects.toBeInstanceOf(NotFoundError);

    const listed = await run((tx) => listVendorContacts(vendorUser, tx, fx.vendorId));
    expect(listed.every((c) => c.vendorId === fx.vendorId)).toBe(true);
    expect(listed.map((c) => c.id)).toContain(mine.id);
  });

  test("personnel cannot list or manage contacts", async () => {
    await expect(run((tx) => listVendorContacts(personnel, tx, fx.vendorId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => addVendorContact(personnel, tx, fx.vendorId, { name: "Nope", phone: "850-555-0105" }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a chosen contact prefills the detail; a phone changed for this detail leaves the contact as saved", async () => {
    const c = await run((tx) => addVendorContact(fx.coord, tx, fx.vendorId, { name: "Gate Lead", phone: "850-555-0110" }));
    const input: JobInput = {
      vendorId: fx.vendorId,
      locationId: null,
      typeId,
      title: "Gate traffic",
      description: null,
      notes: null,
      startAt: new Date(Date.now() + 200 * HOUR),
      endAt: new Date(Date.now() + 204 * HOUR),
      rateCents: null,
      positions: [{ positionTypeId: fx.pos["Deputy Sheriff"], count: 1 }],
      opsPlanRequired: false,
      opsPlanDueAt: null,
      contactName: c.name,
      contactPhone: "850-555-0111",
      held: false,
      flex: null,
    };
    const job = await run((tx) => createJob(fx.coord, tx, input));
    expect(job).toMatchObject({ contactName: "Gate Lead", contactPhone: "850-555-0111" });
    const [saved] = await get().db.select().from(vendorContacts).where(eq(vendorContacts.id, c.id));
    expect(saved.phone).toBe("850-555-0110");
  });

  test("a new contact on a vendor request is saved for future details and copied onto the detail", async () => {
    const [job] = await run((tx) =>
      submitRequest(vendorUser, tx, {
        typeId,
        title: "Youth game",
        startAt: new Date(Date.now() + 100 * HOUR),
        endAt: new Date(Date.now() + 103 * HOUR),
        newContact: { name: "Riley Coach", phone: "850 555 0120", email: "" },
      }),
    );
    const [row] = await get().db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row).toMatchObject({ contactName: "Riley Coach", contactPhone: "850-555-0120" });
    const listed = await run((tx) => listVendorContacts(vendorUser, tx, fx.vendorId));
    const made = listed.find((c) => c.name === "Riley Coach");
    expect(made).toMatchObject({ phone: "850-555-0120", email: null, active: true });
    expect(await auditActions(made!.id)).toEqual(["vendor_contact.create"]);
  });

  test("a bad new contact refuses the whole request", async () => {
    const before = (await get().db.select().from(jobs)).length;
    await expect(
      run((tx) =>
        submitRequest(vendorUser, tx, {
          typeId,
          title: "Youth game",
          startAt: new Date(Date.now() + 100 * HOUR),
          endAt: new Date(Date.now() + 103 * HOUR),
          newContact: { name: "42", phone: "850-555-0121" },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(await get().db.select().from(jobs)).toHaveLength(before);
  });
});
