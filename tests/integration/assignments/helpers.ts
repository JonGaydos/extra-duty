import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { assignments, auditLog, jobPositions, jobs, jobTypes, positionTypes, ranks, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { createJob, type JobInput } from "@/domain/jobs/jobs";
import { agencyInstant } from "@/domain/time/agency-time";
import { makeUser } from "../users/helpers";

export const HOUR = 3_600_000;
export const MIN = 60_000;

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Shared fixture for the cancel and coordinator suites. */
export async function setupFixture(db: Db, prefix: string) {
  await seed(db);
  const coord = (await makeUser(db, "coordinator", `${prefix}-coord@example.test`)).actor;
  const [v] = await db.insert(vendors).values({ name: `${prefix} Vendor`, defaultRateCents: 7000 }).returning();
  const [v2] = await db.insert(vendors).values({ name: `${prefix} Other Vendor`, defaultRateCents: 7000 }).returning();
  const typeId = (await db.select().from(jobTypes).limit(1))[0].id;
  const pos = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
  const rank = Object.fromEntries((await db.select().from(ranks)).map((r) => [r.name, r.id]));
  let seq = 0;
  let userSeq = 0;

  const run = <T>(fn: (tx: Tx) => Promise<T>) => db.transaction(fn);

  const person = async (rankName = "Deputy Sheriff", opts: { w9?: boolean } = {}) => {
    // Sign-ups need an approved W-9 (owner decision 2026-11-27); makeUser gives one unless `w9: false`.
    const { actor } = await makeUser(db, "personnel", `${prefix}${userSeq++}@example.test`, { rankId: rank[rankName] }, { w9: opts.w9 });
    return { ...actor, rankId: rank[rankName] } as Actor;
  };

  const mkJob = async (o: { vendor?: string; count?: number; hours?: [number, number] } = {}) => {
    const n = seq++;
    const month = 3 + Math.floor(n / 25);
    const day = 1 + (n % 25);
    const [sh, eh] = o.hours ?? [17, 23];
    const input: JobInput = {
      vendorId: o.vendor ?? v.id,
      locationId: null,
      typeId,
      title: "Stadium security",
      description: null,
      notes: null,
      startAt: agencyInstant(2035, month, day, sh, 0),
      endAt: agencyInstant(2035, month, day, eh, 0),
      rateCents: null,
      positions: [{ positionTypeId: pos["Deputy Sheriff"], count: o.count ?? 1 }],
      opsPlanRequired: false,
      opsPlanDueAt: null,
      contactName: null,
      contactPhone: null,
      held: false,
      flex: null,
    };
    const job = await run((tx) => createJob(coord, tx, input));
    await db.update(jobs).set({ releaseAt: new Date("2000-01-01") }).where(eq(jobs.id, job.id));
    const [position] = await db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
    return { job, positionId: position.id };
  };

  return { coord, vendorId: v.id, otherVendorId: v2.id, pos, rank, person, mkJob, run };
}

/**
 * A sign-up its person canceled before giving a spot away replaced canceling (2026-11-27), as cancelSignup wrote it
 * then: canceled at once, audited as assignment.cancel. Such sign-ups stay canceled and still count as Gave away.
 */
export async function legacyCancel(db: Db, actor: Actor, assignmentId: string, reason: string): Promise<void> {
  const [before] = await db.select().from(assignments).where(eq(assignments.id, assignmentId));
  const [after] = await db.update(assignments).set({ status: "canceled", backupPosition: null }).where(eq(assignments.id, assignmentId)).returning();
  await db.insert(auditLog).values({ actorUserId: actor.userId, action: "assignment.cancel", entityType: "assignment", entityId: assignmentId, before, after, reason });
}
