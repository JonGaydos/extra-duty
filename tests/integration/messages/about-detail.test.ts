import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { call, sessionToken, bearer } from "../api/helpers";
import { assignments, jobs, messageRecipients, spotOffers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError } from "@/domain/errors";
import { linkableDetails, sendMessage } from "@/domain/messages/messages";
import { POST as postMessage } from "@/app/api/v1/messages/route";

const NOW = new Date("2035-02-01T12:00:00Z");

describe("the About a detail link on a message", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let deputy: Actor;
  let other: Actor;
  let reader: Actor;
  let mine: { jobId: string };
  let offered: { jobId: string };
  let theirs: { jobId: string };
  let past: { jobId: string };
  let backupOnly: { jobId: string };

  const on = async (who: Actor, status: "signed_up" | "pending_short" | "backup", job?: { job: { id: string }; positionId: string }) => {
    const j = job ?? (await f.mkJob({ count: 3 }));
    const [a] = await get().db.insert(assignments).values({ jobId: j.job.id, jobPositionId: j.positionId, userId: who.userId, status }).returning();
    return { jobId: j.job.id, positionId: j.positionId, assignmentId: a.id };
  };

  beforeAll(async () => {
    f = await setupFixture(get().db, "about");
    deputy = await f.person();
    other = await f.person();
    reader = await f.person();
    mine = await on(deputy, "signed_up");
    const o = await on(deputy, "backup");
    await get().db.insert(spotOffers).values({ jobPositionId: o.positionId, mode: "sequential", offeredToAssignmentId: o.assignmentId, endsAt: new Date("2035-12-01T00:00:00Z") });
    offered = o;
    backupOnly = await on(deputy, "backup");
    theirs = await on(other, "signed_up");
    past = await on(deputy, "signed_up");
    await get().db.update(jobs).set({ startAt: new Date("2025-01-01T17:00:00Z"), endAt: new Date("2025-01-01T23:00:00Z") }).where(eq(jobs.id, past.jobId));
  });

  const send = (actor: Actor, jobId: string) =>
    get().db.transaction((tx) => sendMessage(actor, tx, { audiences: [{ kind: "users", userIds: [reader.userId] }], subject: "About it", body: "A question.", jobId }, NOW));

  test("a deputy is offered only details they are signed up, pending or offered a spot on, that have not ended", async () => {
    const ids = (await get().db.transaction((tx) => linkableDetails(deputy, tx, NOW))).map((d) => d.id);
    expect(ids).toContain(mine.jobId);
    expect(ids).toContain(offered.jobId);
    expect(ids).not.toContain(backupOnly.jobId);
    expect(ids).not.toContain(theirs.jobId);
    expect(ids).not.toContain(past.jobId);
  });

  test("staff are offered any detail that has not ended, never a past one", async () => {
    const ids = (await get().db.transaction((tx) => linkableDetails(f.coord, tx, NOW))).map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining([mine.jobId, theirs.jobId, backupOnly.jobId]));
    expect(ids).not.toContain(past.jobId);
  });

  test("a deputy cannot link another person's detail or a past detail; their own works", async () => {
    await expect(send(deputy, theirs.jobId)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(send(deputy, past.jobId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await send(deputy, mine.jobId)).jobId).toBe(mine.jobId);
    await expect(send(f.coord, past.jobId)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await send(f.coord, theirs.jobId)).jobId).toBe(theirs.jobId);
  });

  test("the API refuses both as well", async () => {
    const token = await sessionToken(get().db, deputy.userId);
    for (const jobId of [theirs.jobId, past.jobId]) {
      const res = await call(postMessage, "/api/v1/messages", {
        method: "POST",
        headers: { ...bearer(token), "content-type": "application/json" },
        body: JSON.stringify({ audiences: [{ kind: "coordinators" }], subject: "About it", body: "A question.", jobId }),
      });
      expect(res.status, jobId).toBe(403);
    }
    expect(await get().db.select().from(messageRecipients).where(eq(messageRecipients.userId, other.userId))).toHaveLength(0);
  });
});
