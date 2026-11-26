import { describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import { assignments, jobPositions, jobTypes, positionTypes, ranks, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { signUp } from "@/domain/assignments/signup";
import { createJob, listJobs } from "@/domain/jobs/jobs";
import { deriveJobStatus } from "@/domain/jobs/status";
import { loadJobCards } from "@/domain/personnel/views";
import { approveRequest, submitRequest } from "@/domain/vendor-portal/requests";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";

const HOUR = 3_600_000;

/** Regression: approved (scheduled) details open at releaseAt without anything moving them to another state. */
describe("released details", () => {
  const get = useTestDb();
  useEmailQueue(get);

  async function fixture(p: string) {
    const { db } = get();
    await seed(db);
    const coord = (await makeUser(db, "coordinator", `${p}-coord@example.test`)).actor;
    const rank = Object.fromEntries((await db.select().from(ranks)).map((r) => [r.name, r.id]));
    const pos = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
    const { actor } = await makeUser(db, "personnel", `${p}-deputy@example.test`, { rankId: rank["Deputy Sheriff"] });
    const deputy = { ...actor, rankId: rank["Deputy Sheriff"] } as Actor;
    const [v] = await db.insert(vendors).values({ name: `${p} Vendor`, defaultRateCents: 7000 }).returning();
    const typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    return { db, coord, deputy, pos, vendorId: v.id, typeId };
  }

  /** A start later in the current agency month when there is room, else early next month (also released). */
  function soon(): Date {
    const now = new Date();
    const { year, month, day } = agencyDateParts(new Date(now.getTime() + 26 * HOUR));
    return agencyInstant(year, month, day, 17, 0);
  }

  test("a coordinator-created detail this month is open for sign-up end to end", async () => {
    const { db, coord, deputy, pos, vendorId, typeId } = await fixture("a");
    const startAt = soon();
    const job = await db.transaction((tx) =>
      createJob(coord, tx, {
        vendorId,
        locationId: null,
        typeId,
        title: "Release regression",
        description: null,
        notes: null,
        startAt,
        endAt: new Date(startAt.getTime() + 4 * HOUR),
        rateCents: null,
        positions: [{ positionTypeId: pos["Deputy Sheriff"], count: 2 }],
        opsPlanRequired: false,
        opsPlanDueAt: null,
        contactName: null,
        contactPhone: null,
        held: false,
        flex: null,
      }),
    );
    expect(job.state).toBe("scheduled");
    expect(job.releaseAt!.getTime()).toBeLessThanOrEqual(Date.now());

    const now = new Date();
    expect(deriveJobStatus({ ...job, vendorOnPaymentHold: false, spots: 2 }, [], [], now)).toBe("open");

    const listed = await db.transaction((tx) => listJobs(deputy, tx, { from: new Date(now.getTime() - HOUR), to: new Date(now.getTime() + 40 * 86_400_000) }, 1));
    const row = listed.find((j) => j.id === job.id);
    expect(row).toBeDefined();
    const [card] = await db.transaction((tx) => loadJobCards(deputy, tx, [row!], now));
    expect(card.released).toBe(true);
    expect(card.availability).toBe("open");

    const [position] = await db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
    const a = await db.transaction((tx) => signUp(deputy, tx, position.id, { warningVersion: 1 }));
    expect(a.status).toBe("signed_up");
  });

  test("an approved vendor request opens for sign-up at its release time", async () => {
    const { db, coord, deputy, vendorId, typeId } = await fixture("b");
    const startAt = soon();
    const requested = await db.transaction((tx) =>
      submitRequest(coord, tx, {
        vendorId,
        typeId,
        title: "Vendor release regression",
        startAt,
        endAt: new Date(startAt.getTime() + 4 * HOUR),
      }),
    );
    const id = requested[0].id;
    expect(requested[0].state).toBe("requested");
    await db.transaction((tx) => approveRequest(coord, tx, id));
    const [position] = await db.select().from(jobPositions).where(eq(jobPositions.jobId, id));
    const a = await db.transaction((tx) => signUp(deputy, tx, position.id, { warningVersion: 1 }));
    expect(a.status).toBe("signed_up");
    expect(await db.select().from(assignments).where(eq(assignments.jobId, id))).toHaveLength(1);
  });
});
