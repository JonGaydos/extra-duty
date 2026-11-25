import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useEmailQueue } from "../../setup/email-queue";
import { useTestDb } from "../../setup/test-db";
import { makeUser } from "../users/helpers";
import { auditLog, jobs, jobTypes, positionTypes, vendors, vendorUsers } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ratesOutsideRange, coordinatorTodo } from "@/domain/coordinator/views";
import { ValidationError } from "@/domain/errors";
import { copyJob, createJobsOnDates } from "@/domain/jobs/copy";
import { createJob, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { getSettings, updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { submitRequest } from "@/domain/vendor-portal/requests";
import { createVendor, updateVendor } from "@/domain/vendors/vendors";

describe("agency rate range and approved exceptions", () => {
  const get = useTestDb();
  useEmailQueue(get);
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);
  let coord: Actor;
  let admin: Actor;
  let vendorUser: Actor;
  let vendorId: string;
  let typeId: string;
  let deputyPos: string;

  const base = (over: Partial<JobInput> = {}): JobInput => ({
    vendorId,
    locationId: null,
    typeId,
    title: "Range check",
    description: null,
    notes: null,
    startAt: agencyInstant(2035, 5, 1, 17, 0),
    endAt: agencyInstant(2035, 5, 1, 21, 0),
    rateCents: 7000,
    positions: [{ positionTypeId: deputyPos, count: 1 }],
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: null,
    contactPhone: null,
    held: false,
    ...over,
  });

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coord = (await makeUser(db, "coordinator", "rcoord@example.test")).actor;
    admin = (await makeUser(db, "admin", "radmin@example.test")).actor;
    const [v] = await db.insert(vendors).values({ name: "Range Vendor", defaultRateCents: 7000 }).returning();
    vendorId = v.id;
    const vu = await makeUser(db, "vendor", "rvendor@example.test");
    await db.insert(vendorUsers).values({ userId: vu.row.id, vendorId });
    vendorUser = { ...vu.actor, vendorId };
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    deputyPos = (await db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff")))[0].id;
    await run((tx) => updateSettings(coord, tx, { agencyDefaultRateCents: 6500, defaultPositionTypeId: deputyPos }));
  });

  test("a range is saved only when min is at most max and the defaults fall inside it", async () => {
    await expect(run((tx) => updateSettings(coord, tx, { rateMinCents: 9000, rateMaxCents: 8000 }))).rejects.toThrow("The maximum must be at least the minimum.");
    await expect(run((tx) => updateSettings(coord, tx, { rateMinCents: 6800, rateMaxCents: 9000 }))).rejects.toThrow("The agency default rate of $65 is outside the range. Rate must be between $68 and $90 an hour.");
    await expect(run((tx) => updateSettings(coord, tx, { rateMinCents: 5000, rateMaxCents: 6800 }))).rejects.toThrow("These vendor default rates are outside the range: Range Vendor ($70). Change them first.");
    await run((tx) => updateSettings(coord, tx, { rateMinCents: 5000, rateMaxCents: 9000 }));
    const s = await run((tx) => getSettings(tx));
    expect([s.rateMinCents, s.rateMaxCents]).toEqual([5000, 9000]);
  });

  test("the agency default and vendor defaults must fall inside the range", async () => {
    await expect(run((tx) => updateSettings(coord, tx, { agencyDefaultRateCents: 4000 }))).rejects.toThrow("The agency default rate of $40 is outside the range.");
    await expect(run((tx) => createVendor(coord, tx, { name: "Too dear", typeId: null, contactName: null, phone: null, billingEmails: [], defaultRateCents: 9500, notes: null }))).rejects.toThrow(
      "Rate must be between $50 and $90 an hour.",
    );
    await expect(run((tx) => updateVendor(coord, tx, vendorId, { defaultRateCents: 4900 }))).rejects.toBeInstanceOf(ValidationError);
    await run((tx) => updateVendor(coord, tx, vendorId, { defaultRateCents: 7500 }));
  });

  test("createJob refuses a rate outside the range, and one side unset says at least or at most", async () => {
    await expect(run((tx) => createJob(coord, tx, base({ rateCents: 9500 })))).rejects.toThrow("Rate must be between $50 and $90 an hour.");
    await run((tx) => updateSettings(coord, tx, { rateMaxCents: null }));
    await expect(run((tx) => createJob(coord, tx, base({ rateCents: 4000 })))).rejects.toThrow("Rate must be at least $50 an hour.");
    await run((tx) => updateSettings(coord, tx, { rateMinCents: null, rateMaxCents: 9000 }));
    await expect(run((tx) => createJob(coord, tx, base({ rateCents: 9500 })))).rejects.toThrow("Rate must be at most $90 an hour.");
    await run((tx) => updateSettings(coord, tx, { rateMinCents: 5000 }));
  });

  test("a coordinator approves one detail outside the range with a reason; it is stored and audited", async () => {
    const job = await run((tx) => createJob(coord, tx, base({ rateCents: 9500, rateOverrideReason: "Holiday premium agreed with the vendor" })));
    expect(job).toMatchObject({ rateCents: 9500, rateOverrideReason: "Holiday premium agreed with the vendor", rateOverrideBy: coord.userId });
    expect(job.rateOverrideAt).toBeInstanceOf(Date);
    const [a] = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, job.id), eq(auditLog.action, "job.rate_override")));
    expect(a.after).toMatchObject({ rateCents: 9500, rateOverrideReason: "Holiday premium agreed with the vendor" });
    await expect(run((tx) => createJob(coord, tx, base({ rateCents: 9500, rateOverrideReason: "x".repeat(501) })))).rejects.toThrow("Keep the reason to 500 characters.");
    // A blank reason is no reason.
    await expect(run((tx) => createJob(coord, tx, base({ rateCents: 9500, rateOverrideReason: "  " })))).rejects.toBeInstanceOf(ValidationError);
  });

  test("updateJob one: a new out-of-range rate needs a reason; back inside drops the override", async () => {
    const [job] = [await run((tx) => createJob(coord, tx, base()))];
    await expect(run((tx) => updateJob(coord, tx, job.id, { rateCents: 9900 }, "one"))).rejects.toThrow("Rate must be between $50 and $90 an hour.");
    const [o] = await run((tx) => updateJob(admin, tx, job.id, { rateCents: 9900, rateOverrideReason: "Night shift on a holiday" }, "one"));
    expect(o).toMatchObject({ rateCents: 9900, rateOverrideReason: "Night shift on a holiday", rateOverrideBy: admin.userId });
    // Saving the editor again with the same rate and no reason keeps the approval.
    const [same] = await run((tx) => updateJob(coord, tx, job.id, { rateCents: 9900, title: "Renamed" }, "one"));
    expect(same.rateOverrideReason).toBe("Night shift on a holiday");
    const [back] = await run((tx) => updateJob(coord, tx, job.id, { rateCents: 8000 }, "one"));
    expect(back).toMatchObject({ rateCents: 8000, rateOverrideReason: null, rateOverrideBy: null, rateOverrideAt: null });
    const actions = (await get().db.select().from(auditLog).where(eq(auditLog.entityId, job.id))).map((r) => r.action);
    expect(actions).toEqual(expect.arrayContaining(["job.rate_override", "job.rate_override_cleared"]));
  });

  test("a series edit never grants an exception and names the detail it refuses", async () => {
    const made = await run((tx) => createJobsOnDates(coord, tx, base({ title: "Series range" }), ["2035-08-01", "2035-08-08"]));
    await expect(run((tx) => updateJob(coord, tx, made[0].id, { rateCents: 9900, rateOverrideReason: "Holiday" }, "series"))).rejects.toThrow(/^Series range, .*: Rate must be between \$50 and \$90 an hour\.$/);
    const rates = (await get().db.select().from(jobs).where(eq(jobs.seriesId, made[0].seriesId!))).map((j) => j.rateCents);
    expect(rates).toEqual([7000, 7000]);
  });

  test("bulk dates and copies never carry an exception", async () => {
    await expect(run((tx) => createJobsOnDates(coord, tx, base({ rateCents: 9900, rateOverrideReason: "Holiday" }), ["2035-09-01", "2035-09-08"]))).rejects.toThrow(
      "2035-09-01: Rate must be between $50 and $90 an hour.",
    );
    const approved = await run((tx) => createJob(coord, tx, base({ title: "Approved source", rateCents: 9900, rateOverrideReason: "One-off" })));
    await expect(run((tx) => copyJob(coord, tx, approved.id, { kind: "dates", dates: ["2035-10-01"] }, {}))).rejects.toThrow(
      /Rate must be between \$50 and \$90 an hour/,
    );
  });

  test("vendors can never use an exception, even when they may set the rate", async () => {
    await run((tx) => updateSettings(coord, tx, { vendorCanSetRate: true }));
    const req = (rateCents: number) => ({ typeId, title: "Vendor ask", startAt: agencyInstant(2035, 11, 1, 17, 0), endAt: agencyInstant(2035, 11, 1, 21, 0), rateCents });
    await expect(run((tx) => submitRequest(vendorUser, tx, req(9900)))).rejects.toThrow("Rate must be between $50 and $90 an hour.");
    const [ok] = await run((tx) => submitRequest(vendorUser, tx, req(8500)));
    expect(ok.rateCents).toBe(8500);
    await expect(run((tx) => updateJob(coord, tx, ok.id, { rateCents: 9900 }, "one"))).rejects.toBeInstanceOf(ValidationError);
    await run((tx) => updateSettings(coord, tx, { vendorCanSetRate: false }));
  });

  test("details already outside a new range keep their rate and are listed until approved", async () => {
    const { db } = get();
    const kept = await run((tx) => createJob(coord, tx, base({ title: "Kept at 85", rateCents: 8500, startAt: agencyInstant(2035, 12, 1, 17, 0), endAt: agencyInstant(2035, 12, 1, 21, 0) })));
    // Lower the ceiling below the vendor default first, so the vendor default is moved inside.
    await run((tx) => updateVendor(coord, tx, vendorId, { defaultRateCents: 6000 }));
    await run((tx) => updateSettings(coord, tx, { rateMaxCents: 8000 }));
    const [still] = await db.select().from(jobs).where(eq(jobs.id, kept.id));
    expect(still.rateCents).toBe(8500);
    const s = await run((tx) => getSettings(tx));
    let list = await run((tx) => ratesOutsideRange(tx, s, new Date()));
    expect(list.map((r) => r.title)).toContain("Kept at 85");
    // Approved exceptions are not warnings.
    expect(list.map((r) => r.title)).not.toContain("Approved source");
    // Editing something else on it is fine: the rate did not change.
    await run((tx) => updateJob(coord, tx, kept.id, { rateCents: 8500, title: "Kept at 85" }, "one"));
    await run((tx) => updateJob(coord, tx, kept.id, { rateOverrideReason: "Agreed before the range" }, "one"));
    list = await run((tx) => ratesOutsideRange(tx, s, new Date()));
    expect(list.map((r) => r.title)).not.toContain("Kept at 85");
    const todo = await run((tx) => coordinatorTodo(coord, tx));
    expect(todo.ratesOutOfRange.map((r) => r.jobId)).not.toContain(kept.id);
  });

  test("an inactive vendor's old default never blocks a new range", async () => {
    const { db } = get();
    await db.insert(vendors).values({ name: "Gone Vendor", defaultRateCents: 20000, active: false });
    await run((tx) => updateSettings(coord, tx, { rateMaxCents: 8500 }));
    expect((await run((tx) => getSettings(tx))).rateMaxCents).toBe(8500);
  });

  test("a vendor default of zero is refused", async () => {
    await expect(run((tx) => updateVendor(coord, tx, vendorId, { defaultRateCents: 0 }))).rejects.toThrow("The default rate must be more than zero, or blank to use the agency default.");
  });
});
