import { beforeAll, describe, expect, test } from "vitest";
import { useEmailQueue } from "../setup/email-queue";
import { useTestDb } from "../setup/test-db";
import { makeUser } from "./users/helpers";
import { jobs, jobTypes, positionTypes, users, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { createJob, updateJob } from "@/domain/jobs/jobs";
import { getSettings, updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { getOwnContact, updateOwnContact } from "@/domain/users/contact";
import { createUser, updateUser } from "@/domain/users/users";
import { createVendor, updateVendor } from "@/domain/vendors/vendors";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";

describe("every saved phone is ###-###-####", () => {
  const get = useTestDb();
  useEmailQueue(get);
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);
  let coord: Actor;
  let deputy: Actor;

  beforeAll(async () => {
    await seed(get().db);
    coord = (await makeUser(get().db, "coordinator", "pcoord@example.test")).actor;
    deputy = (await makeUser(get().db, "personnel", "pdeputy@example.test")).actor;
  });

  test("a deputy's own phone", async () => {
    await run((tx) => updateOwnContact(deputy, tx, { phone: "+1 850 555 0148", mailingAddress: null }));
    expect((await run((tx) => getOwnContact(deputy, tx))).phone).toBe("850-555-0148");
    await expect(run((tx) => updateOwnContact(deputy, tx, { phone: "555-0148", mailingAddress: null }))).rejects.toThrow("Enter a 10-digit phone number");
  });

  test("a new user's phone", async () => {
    const u = await run((tx) => createUser(coord, tx, { email: "pnew@example.test", name: "P New", phone: "(850) 555-0101", role: "personnel", rankId: null, badgeNumber: null }));
    expect(u.phone).toBe("850-555-0101");
    await expect(run((tx) => createUser(coord, tx, { email: "pbad@example.test", name: "P Bad", phone: "12", role: "personnel", rankId: null, badgeNumber: null }))).rejects.toThrow("Enter a 10-digit phone number");
  });

  test("a vendor's phone", async () => {
    const v = await run((tx) => createVendor(coord, tx, { name: "Phone Vendor", typeId: null, contactName: null, phone: "8505550148", billingEmails: [], defaultRateCents: null, notes: null }));
    expect(v.phone).toBe("850-555-0148");
    await expect(run((tx) => updateVendor(coord, tx, v.id, { phone: "850-555-014" }))).rejects.toThrow("Enter a 10-digit phone number");
  });

  test("a detail's contact phone", async () => {
    const [v] = await get().db.insert(vendors).values({ name: "Contact Vendor", defaultRateCents: 7000 }).returning();
    const [type] = await get().db.select().from(jobTypes).limit(1);
    const [pos] = await get().db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
    const input = { vendorId: v.id, locationId: null, typeId: type.id, title: "Contact", description: null, notes: null, startAt: agencyInstant(2035, 3, 1, 9, 0), endAt: agencyInstant(2035, 3, 1, 13, 0), rateCents: null, positions: [{ positionTypeId: pos.id, count: 1 }], opsPlanRequired: false, opsPlanDueAt: null, contactName: "Gate", held: false };
    const job = await run((tx) => createJob(coord, tx, { ...input, contactPhone: "850.555.0148" }));
    expect(job.contactPhone).toBe("850-555-0148");
    await expect(run((tx) => createJob(coord, tx, { ...input, contactPhone: "call the office" }))).rejects.toThrow("Enter a 10-digit phone number");
  });

  test("a detail's site contact name must contain a letter; an unchanged old one never blocks an edit", async () => {
    const { db } = get();
    const [v] = await db.insert(vendors).values({ name: "Name Vendor", defaultRateCents: 7000 }).returning();
    const [type] = await db.select().from(jobTypes).limit(1);
    const [pos] = await db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
    const input = { vendorId: v.id, locationId: null, typeId: type.id, title: "Name", description: null, notes: null, startAt: agencyInstant(2035, 4, 1, 9, 0), endAt: agencyInstant(2035, 4, 1, 13, 0), rateCents: null, positions: [{ positionTypeId: pos.id, count: 1 }], opsPlanRequired: false, opsPlanDueAt: null, contactPhone: null, held: false };
    await expect(run((tx) => createJob(coord, tx, { ...input, contactName: "123" }))).rejects.toThrow("Enter a name with at least one letter");
    const job = await run((tx) => createJob(coord, tx, { ...input, contactName: "  Rowan Fairley " }));
    expect(job.contactName).toBe("Rowan Fairley");
    await expect(run((tx) => updateJob(coord, tx, job.id, { contactName: "13" }, "one"))).rejects.toThrow("Enter a name with at least one letter");
    // Saved before the rule: an unrelated edit still saves.
    await db.update(jobs).set({ contactName: "123", contactPhone: "13" }).where(eq(jobs.id, job.id));
    const [edited] = await run((tx) => updateJob(coord, tx, job.id, { title: "Name two", contactName: "123", contactPhone: "13" }, "one"));
    expect(edited).toMatchObject({ title: "Name two", contactName: "123", contactPhone: "13" });
  });

  test("a vendor's contact name must contain a letter", async () => {
    await expect(run((tx) => createVendor(coord, tx, { name: "Name Check Vendor", typeId: null, contactName: "555", phone: null, billingEmails: [], defaultRateCents: null, notes: null }))).rejects.toThrow("Enter a name with at least one letter");
    const v = await run((tx) => createVendor(coord, tx, { name: "Name Check Vendor", typeId: null, contactName: "Lee Ortiz", phone: null, billingEmails: [], defaultRateCents: null, notes: null }));
    await expect(run((tx) => updateVendor(coord, tx, v.id, { contactName: "--" }))).rejects.toThrow("Enter a name with at least one letter");
  });

  test("the agency phone", async () => {
    await run((tx) => updateSettings(coord, tx, { agency: { phone: "18505550148" } }));
    expect((await run((tx) => getSettings(tx))).agency.phone).toBe("850-555-0148");
    await run((tx) => updateSettings(coord, tx, { agency: { phone: "" } }));
    expect((await run((tx) => getSettings(tx))).agency.phone).toBe("");
    await expect(run((tx) => updateSettings(coord, tx, { agency: { phone: "555" } }))).rejects.toThrow("Enter a 10-digit phone number");
  });

  test("an unchanged old number never blocks an edit; a changed one must be valid", async () => {
    const { db } = get();
    const [u] = await db.insert(users).values({ name: "Old Phone", email: "oldphone@example.test", role: "personnel", phone: "555-1234" }).returning();
    const saved = await run((tx) => updateUser(coord, tx, u.id, { name: "Old Phone Two", phone: "555-1234" }));
    expect(saved).toMatchObject({ name: "Old Phone Two", phone: "555-1234" });
    await expect(run((tx) => updateUser(coord, tx, u.id, { phone: "555-1235" }))).rejects.toThrow("Enter a 10-digit phone number");
  });

  test("the migration rewrites convertible saved numbers and leaves the rest", async () => {
    const { db } = get();
    const [a] = await db.insert(users).values({ name: "Mig A", email: "miga@example.test", role: "personnel", phone: "(850) 555-0148" }).returning();
    const [b] = await db.insert(users).values({ name: "Mig B", email: "migb@example.test", role: "personnel", phone: "1 850 555 0149" }).returning();
    const [c] = await db.insert(users).values({ name: "Mig C", email: "migc@example.test", role: "personnel", phone: "ext 12" }).returning();
    const [v] = await db.insert(vendors).values({ name: "Mig Vendor", phone: "850.555.0150" }).returning();
    const file = readFileSync(join(process.cwd(), "src/db/migrations/0022_normalize_phones.sql"), "utf8");
    for (const stmt of file.split("--> statement-breakpoint")) await db.execute(sql.raw(stmt));
    const phone = async (id: string) => (await db.select({ p: users.phone }).from(users).where(eq(users.id, id)))[0].p;
    expect([await phone(a.id), await phone(b.id), await phone(c.id)]).toEqual(["850-555-0148", "850-555-0149", "ext 12"]);
    expect((await db.select({ p: vendors.phone }).from(vendors).where(eq(vendors.id, v.id)))[0].p).toBe("850-555-0150");
  });
});
