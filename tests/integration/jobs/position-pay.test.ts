import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { asc, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, jobPositions, jobTypes, positionTypes, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment } from "@/domain/billing/bill";
import { ValidationError } from "@/domain/errors";
import { updatePositionType } from "@/domain/jobs/job-types";
import { createJob, updateJob } from "@/domain/jobs/jobs";
import { loadJobCards } from "@/domain/personnel/views";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

const AFTER = new Date("2036-06-01T00:00:00Z");

describe("position pay differential", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let typeId: string;

  beforeAll(async () => {
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-pp-"));
    setEmailSender(createMemorySender());
    fx = await setupFixture(get().db, "pp");
    admin = (await makeUser(get().db, "admin", "pp-admin@example.test")).actor;
    typeId = (await get().db.select().from(jobTypes).limit(1))[0].id;
    await get().db.update(vendors).set({ billingEmails: ["ap@vendor.example"], defaultRateCents: 5000 });
    await get().db.transaction((tx) =>
      updateSettings(admin, tx, {
        email: { provider: "smtp", from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } },
        billingReplyToEmail: "billing@sheriff.example",
        invoiceReviewMode: "immediate",
        minimumBillableMinutes: 0,
        hourRoundingMinutes: 15,
      }),
    );
  });

  const mkDetail = (rateCents: number, day = 1) =>
    fx.run((tx) =>
      createJob(fx.coord, tx, {
        vendorId: fx.vendorId,
        locationId: null,
        typeId,
        title: "Parade",
        description: null,
        notes: null,
        startAt: agencyInstant(2036, 3, day, 9, 0),
        endAt: agencyInstant(2036, 3, day, 13, 0),
        rateCents,
        positions: [
          { positionTypeId: fx.pos["Deputy Sheriff"], count: 2 },
          { positionTypeId: fx.pos["Incident Commander"], count: 1 },
        ],
        opsPlanRequired: false,
        opsPlanDueAt: null,
        contactName: null,
        contactPhone: null,
        held: false,
        flex: null,
      }),
    );

  test("seeded differentials: Incident Commander +$25.00, others $0", async () => {
    const rows = await get().db.select().from(positionTypes);
    for (const r of rows) expect(r.rateDifferentialCents).toBe(r.name === "Incident Commander" ? 2500 : 0);
  });

  test("each position snapshots its differential; later setting changes leave existing details alone", async () => {
    const job = await mkDetail(5000, 2);
    const ic = (await get().db.select().from(positionTypes).where(eq(positionTypes.id, fx.pos["Incident Commander"])))[0];
    await fx.run((tx) =>
      updatePositionType(admin, tx, ic.id, {
        name: ic.name,
        eligibleRankIds: ic.eligibleRankIds,
        requiredQualificationIds: ic.requiredQualificationIds,
        isIncidentCommander: true,
        vendorRequestable: ic.vendorRequestable,
        rateDifferentialCents: 4000,
      }),
    );
    const positions = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id)).orderBy(asc(jobPositions.createdAt));
    expect(positions.map((p) => p.rateDifferentialCents).sort()).toEqual([0, 2500]);
    const later = await mkDetail(5000, 3);
    const laterIc = (await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, later.id))).find((p) => p.positionTypeId === ic.id)!;
    expect(laterIc.rateDifferentialCents).toBe(4000);
    // Put the setting back for the other tests.
    await fx.run((tx) => updatePositionType(admin, tx, ic.id, { name: ic.name, eligibleRankIds: ic.eligibleRankIds, requiredQualificationIds: ic.requiredQualificationIds, isIncidentCommander: true, vendorRequestable: ic.vendorRequestable, rateDifferentialCents: 2500 }));
  });

  test("a negative or fractional differential is refused", async () => {
    const ic = (await get().db.select().from(positionTypes).where(eq(positionTypes.id, fx.pos["Incident Commander"])))[0];
    const base = { name: ic.name, eligibleRankIds: ic.eligibleRankIds, requiredQualificationIds: ic.requiredQualificationIds, isIncidentCommander: true, vendorRequestable: true };
    await expect(fx.run((tx) => updatePositionType(admin, tx, ic.id, { ...base, rateDifferentialCents: -100 }))).rejects.toBeInstanceOf(ValidationError);
    await expect(fx.run((tx) => updatePositionType(admin, tx, ic.id, { ...base, rateDifferentialCents: 10.5 }))).rejects.toBeInstanceOf(ValidationError);
  });

  test("cards show each position's rate; editing the base rate re-derives it", async () => {
    const job = await mkDetail(5000, 4);
    const card = async () => (await fx.run((tx) => loadJobCards(fx.coord, tx, [job])))[0];
    const before = await card();
    expect(before.positions.map((p) => p.rateCents).sort()).toEqual([5000, 7500]);
    // 4 hours: base $200, Incident Commander $300.
    expect(before.totalCents).toBe(20000);
    expect(before.maxTotalCents).toBe(30000);
    expect(before.maxRateCents).toBe(7500);
    const [after] = await fx.run((tx) => updateJob(fx.coord, tx, job.id, { rateCents: 6000 }, "one"));
    const again = (await fx.run((tx) => loadJobCards(fx.coord, tx, [after])))[0];
    expect(again.positions.map((p) => p.rateCents).sort()).toEqual([6000, 8500]);
  });

  test("billing an Incident Commander spot uses the position's rate, late cancellations too", async () => {
    const job = await mkDetail(5000, 5);
    const icPos = (await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id))).find((p) => p.positionTypeId === fx.pos["Incident Commander"])!;
    for (const status of ["signed_up", "late_canceled"] as const) {
      const person = await fx.person();
      await get().db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, person.userId));
      const [a] = await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: icPos.id, userId: person.userId, status }).returning();
      const { invoice } = await fx.run((tx) => billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, AFTER));
      expect(invoice.rateCents).toBe(7500);
      if (status === "signed_up") expect(invoice.totalCents).toBe(30000);
    }
  });

  test("the agency range applies to the base rate; the differential goes on top", async () => {
    await fx.run((tx) => updateSettings(admin, tx, { rateMinCents: 4000, rateMaxCents: 6000 }));
    const job = await mkDetail(6000, 6);
    const card = (await fx.run((tx) => loadJobCards(fx.coord, tx, [job])))[0];
    expect(Math.max(...card.positions.map((p) => p.rateCents))).toBe(8500);
    await fx.run((tx) => updateSettings(admin, tx, { rateMinCents: null, rateMaxCents: null }));
  });
});
