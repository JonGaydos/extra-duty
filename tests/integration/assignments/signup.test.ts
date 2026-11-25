import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, jobPositions, jobs, jobWatches, notifications, positionTypes, ranks, vendors } from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import {
  changePlannedTimes,
  confirmPendingShortTick,
  eligibilityFor,
  joinBackup,
  listOpenWatches,
  signUp,
  unwatchJob,
  watchJob,
} from "@/domain/assignments/signup";
import { ForbiddenError, RuleViolation, ValidationError } from "@/domain/errors";
import { createJob, type JobInput } from "@/domain/jobs/jobs";
import { jobTypes } from "@/db/schema";
import { agencyInstant } from "@/domain/time/agency-time";

const HOUR = 3_600_000;

describe("sign-up", () => {
  const get = useTestDb();
  useEmailQueue(get);
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) =>
    get().db.transaction(fn);
  let coord: Actor;
  let vendorId: string;
  let typeId: string;
  let pos: Record<string, string>;
  let rank: Record<string, string>;
  let seq = 0;
  let userSeq = 0;

  const nextDay = () => {
    const n = seq++;
    return { month: 3 + Math.floor(n / 25), day: 1 + (n % 25) };
  };

  const person = async (rankName = "Deputy Sheriff") => {
    const { actor } = await makeUser(get().db, "personnel", `su${userSeq++}@example.test`, { rankId: rank[rankName] });
    return { ...actor, rankId: rank[rankName] } as Actor;
  };

  /** A released job on its own day. Hours are agency time. */
  const mkJob = async (
    o: {
      start?: [number, number];
      end?: [number, number];
      day?: { month: number; day: number };
      positions?: { type: string; count: number }[];
      flex?: { earliest: [number, number]; latest: [number, number]; allowShorter: boolean };
    } = {},
  ) => {
    const d = o.day ?? nextDay();
    const at = (h: number, m: number, plus = 0) => agencyInstant(2035, d.month, d.day + plus, h, m);
    const [sh, sm] = o.start ?? [17, 0];
    const [eh, em] = o.end ?? [23, 0];
    const input: JobInput = {
      vendorId,
      locationId: null,
      typeId,
      title: "Stadium security",
      description: null,
      notes: null,
      startAt: at(sh, sm),
      endAt: at(eh, em),
      rateCents: null,
      positions: (o.positions ?? [{ type: "Deputy Sheriff", count: 1 }]).map((p) => ({ positionTypeId: pos[p.type], count: p.count })),
      opsPlanRequired: false,
      opsPlanDueAt: null,
      contactName: null,
      contactPhone: null,
      held: false,
      flex: o.flex
        ? {
            earliestStartAt: at(o.flex.earliest[0], o.flex.earliest[1]),
            latestEndAt: at(o.flex.latest[0] % 24, o.flex.latest[1], o.flex.latest[0] >= 24 ? 1 : 0),
            allowShorter: o.flex.allowShorter,
          }
        : null,
    };
    const job = await run((tx) => createJob(coord, tx, input));
    await get().db.update(jobs).set({ releaseAt: new Date("2000-01-01") }).where(eq(jobs.id, job.id));
    const positions = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
    return { job, positionIds: positions.map((p) => p.id), positionId: positions[0].id, at };
  };

  const warning = { warningVersion: 1 };
  const sign = (a: Actor, positionId: string, extra: Record<string, unknown> = {}) =>
    run((tx) => signUp(a, tx, positionId, { ...warning, ...extra }));
  const violation = async (p: Promise<unknown>) => {
    const e = await p.then(
      () => null,
      (err: unknown) => err,
    );
    expect(e).toBeInstanceOf(RuleViolation);
    return (e as RuleViolation).checks.filter((c) => !c.ok);
  };

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coord = (await makeUser(db, "coordinator", "su-coord@example.test")).actor;
    const [v] = await db.insert(vendors).values({ name: "Signup Vendor", defaultRateCents: 7000 }).returning();
    vendorId = v.id;
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    pos = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
    rank = Object.fromEntries((await db.select().from(ranks)).map((r) => [r.name, r.id]));
  });

  test("signs up, stores the warning version and audits", async () => {
    const { job, positionId } = await mkJob();
    const me = await person();
    const a = await sign(me, positionId, { now: new Date(job.startAt.getTime() - 48 * HOUR) });
    expect(a.status).toBe("signed_up");
    expect(a.warningVersion).toBe("1");
    expect(a.plannedStartAt).toEqual(job.startAt);
    const log = await get().db.select().from(auditLog).where(eq(auditLog.entityId, a.id));
    expect(log.map((l) => l.action)).toContain("assignment.signup");
  });

  test("a stale warning version is a rule violation", async () => {
    const { positionId } = await mkJob();
    const me = await person();
    const bad = await violation(sign(me, positionId, { warningVersion: 0 }));
    expect(bad).toEqual([{ check: "state", ok: false, message: "Read and accept the current sign-up warning" }]);
  });

  test("a vendor cannot sign up", async () => {
    const { positionId } = await mkJob();
    const { actor } = await makeUser(get().db, "vendor", `su${userSeq++}@example.test`);
    await expect(sign({ ...actor, vendorId }, positionId)).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("two concurrent sign-ups for the last spot yield one assignment and one full violation", async () => {
    const { job, positionId } = await mkJob();
    const [a, b] = [await person(), await person()];
    const now = new Date(job.startAt.getTime() - 48 * HOUR);
    const results = await Promise.allSettled([sign(a, positionId, { now }), sign(b, positionId, { now })]);
    const ok = results.filter((r) => r.status === "fulfilled");
    const bad = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(bad).toHaveLength(1);
    expect(bad[0].reason).toBeInstanceOf(RuleViolation);
    expect((bad[0].reason as RuleViolation).checks).toContainEqual({ check: "state", ok: false, message: "This position is full" });
    const rows = await get().db.select().from(assignments).where(and(eq(assignments.jobPositionId, positionId), eq(assignments.status, "signed_up")));
    expect(rows).toHaveLength(1);
  });

  test("a full position reports its real failing checks too", async () => {
    const { positionId } = await mkJob();
    await sign(await person(), positionId);
    const posse = await person("Posse");
    const checks = await violation(sign(posse, positionId));
    expect(checks.map((c) => c.check).sort()).toEqual(["rank", "state"]);
  });

  test("backups are numbered 1, 2, 3 in order and need a full position", async () => {
    const { positionId } = await mkJob();
    const [first, b1, b2, b3] = [await person(), await person(), await person(), await person()];
    const early = await violation(run((tx) => joinBackup(b1, tx, positionId, warning)));
    expect(early.map((c) => c.message)).toEqual(["This position has open spots. Sign up instead."]);
    await sign(first, positionId);
    const got: (number | null)[] = [];
    for (const b of [b1, b2, b3]) got.push((await run((tx) => joinBackup(b, tx, positionId, warning))).backupPosition);
    expect(got).toEqual([1, 2, 3]);
    await expect(run((tx) => joinBackup(b1, tx, positionId, warning))).rejects.toBeInstanceOf(RuleViolation);
  });

  describe("flex times", () => {
    const flex = { earliest: [17, 0] as [number, number], latest: [24, 0] as [number, number], allowShorter: false };

    test("accepts 5:45 PM to 11:45 PM and refuses 9:00 PM to 3:00 AM", async () => {
      const { job, positionId, at } = await mkJob({ flex });
      const me = await person();
      const now = new Date(job.startAt.getTime() - 48 * HOUR);
      await expect(sign(me, positionId, { now, plannedStartAt: at(21, 0), plannedEndAt: at(3, 0, 1) })).rejects.toBeInstanceOf(ValidationError);
      const a = await sign(me, positionId, { now, plannedStartAt: at(17, 45), plannedEndAt: at(23, 45) });
      expect(a.status).toBe("signed_up");
      expect(a.plannedStartAt).toEqual(at(17, 45));
    });

    test("a shorter request before the window is pending_short, holds no spot, and loses to a full-length sign-up", async () => {
      const { job, positionId, at } = await mkJob({ flex: { ...flex, allowShorter: true } });
      const [shortUser, fullUser] = [await person(), await person()];
      const pending = await sign(shortUser, positionId, {
        now: new Date(job.startAt.getTime() - 72 * HOUR),
        plannedStartAt: at(18, 0),
        plannedEndAt: at(23, 0),
      });
      expect(pending.status).toBe("pending_short");
      const full = await sign(fullUser, positionId, { now: new Date(job.startAt.getTime() - 40 * HOUR) });
      expect(full.status).toBe("signed_up");

      await run((tx) => confirmPendingShortTick(new Date(job.startAt.getTime() - 23 * HOUR), tx));
      const [after] = await get().db.select().from(assignments).where(eq(assignments.id, pending.id));
      expect(after.status).toBe("canceled");
      const [note] = await get().db.select().from(notifications).where(eq(notifications.userId, shortUser.userId));
      expect(note.type).toBe("signup.short_declined");
      expect(note.body).toBe("Filled by full-length sign-ups");
    });

    test("a pending request with a free spot is confirmed when the window opens", async () => {
      const { job, positionId, at } = await mkJob({ flex: { ...flex, allowShorter: true } });
      const me = await person();
      const pending = await sign(me, positionId, {
        now: new Date(job.startAt.getTime() - 72 * HOUR),
        plannedStartAt: at(18, 0),
        plannedEndAt: at(23, 0),
      });
      await run((tx) => confirmPendingShortTick(new Date(job.startAt.getTime() - 30 * HOUR), tx));
      expect((await get().db.select().from(assignments).where(eq(assignments.id, pending.id)))[0].status).toBe("pending_short");
      await run((tx) => confirmPendingShortTick(new Date(job.startAt.getTime() - 23 * HOUR), tx));
      expect((await get().db.select().from(assignments).where(eq(assignments.id, pending.id)))[0].status).toBe("signed_up");
      const [note] = await get().db.select().from(notifications).where(eq(notifications.userId, me.userId));
      expect(note.type).toBe("signup.short_confirmed");
    });

    test("two pending requests confirm in request order", async () => {
      const { job, positionId, at } = await mkJob({ flex: { ...flex, allowShorter: true } });
      const [early, late] = [await person(), await person()];
      const p = { plannedStartAt: at(18, 0), plannedEndAt: at(23, 0) };
      // The later request is made first, so request order differs from insertion order of ids.
      const second = await sign(late, positionId, { ...p, now: new Date(job.startAt.getTime() - 70 * HOUR) });
      const first = await sign(early, positionId, { ...p, now: new Date(job.startAt.getTime() - 71 * HOUR) });
      await run((tx) => confirmPendingShortTick(new Date(job.startAt.getTime() - 23 * HOUR), tx));
      const status = async (id: string) => (await get().db.select().from(assignments).where(eq(assignments.id, id)))[0].status;
      expect(await status(first.id)).toBe("signed_up");
      expect(await status(second.id)).toBe("canceled");
    });

    test("a shorter sign-up inside the window with a free spot is signed_up at once", async () => {
      const { job, positionId, at } = await mkJob({ flex: { ...flex, allowShorter: true } });
      const a = await sign(await person(), positionId, {
        now: new Date(job.startAt.getTime() - 20 * HOUR),
        plannedStartAt: at(18, 0),
        plannedEndAt: at(23, 0),
      });
      expect(a.status).toBe("signed_up");
    });

    test("overlap uses the planned interval: 5:45 PM clears a 5:30 PM end, 5:15 PM does not", async () => {
      const day = nextDay();
      const other = await mkJob({ day, start: [12, 0], end: [17, 30] });
      const target = await mkJob({ day, flex });
      const me = await person();
      const now = new Date(other.job.startAt.getTime() - 48 * HOUR);
      await sign(me, other.positionId, { now });
      const bad = await violation(sign(me, target.positionId, { now, plannedStartAt: target.at(17, 15), plannedEndAt: target.at(23, 15) }));
      expect(bad.map((c) => c.check)).toEqual(["overlap"]);
      const ok = await sign(me, target.positionId, { now, plannedStartAt: target.at(17, 45), plannedEndAt: target.at(23, 45) });
      expect(ok.status).toBe("signed_up");
    });

    test("changePlannedTimes re-checks overlap and refuses after the start", async () => {
      const day = nextDay();
      const other = await mkJob({ day, start: [12, 0], end: [17, 30] });
      const target = await mkJob({ day, flex });
      const me = await person();
      const now = new Date(other.job.startAt.getTime() - 48 * HOUR);
      await sign(me, other.positionId, { now });
      const a = await sign(me, target.positionId, { now, plannedStartAt: target.at(17, 45), plannedEndAt: target.at(23, 45) });
      const bad = await run((tx) => changePlannedTimes(me, tx, a.id, { startAt: target.at(17, 15), endAt: target.at(23, 15) }, now)).then(
        () => null,
        (e: unknown) => e,
      );
      expect(bad).toBeInstanceOf(RuleViolation);
      const moved = await run((tx) => changePlannedTimes(me, tx, a.id, { startAt: target.at(18, 0), endAt: target.at(24, 0, 0) }, now));
      expect(moved.plannedStartAt).toEqual(target.at(18, 0));
      await expect(
        run((tx) => changePlannedTimes(me, tx, a.id, { startAt: target.at(18, 0), endAt: target.at(24, 0) }, target.job.startAt)),
      ).rejects.toBeInstanceOf(ValidationError);
      const stranger = await person();
      await expect(
        run((tx) => changePlannedTimes(stranger, tx, a.id, { startAt: target.at(18, 0), endAt: target.at(24, 0) }, now)),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });
  });

  test("watching is idempotent, ends on sign-up and counts as ended once the job starts", async () => {
    const { job, positionId } = await mkJob();
    const holder = await person();
    await sign(holder, positionId);
    const me = await person();
    const now = new Date(job.startAt.getTime() - 48 * HOUR);
    const w1 = await run((tx) => watchJob(me, tx, job.id, now));
    const w2 = await run((tx) => watchJob(me, tx, job.id, now));
    expect(w2.id).toBe(w1.id);
    expect(await run((tx) => listOpenWatches(tx, job.id, now))).toHaveLength(1);
    expect(await run((tx) => listOpenWatches(tx, job.id, job.startAt))).toHaveLength(0);
    await expect(run((tx) => watchJob(me, tx, job.id, job.startAt))).rejects.toBeInstanceOf(ValidationError);

    const { job: j2, positionId: p2 } = await mkJob();
    const w = await run((tx) => watchJob(me, tx, j2.id, new Date(j2.startAt.getTime() - 48 * HOUR)));
    await sign(me, p2, { now: new Date(j2.startAt.getTime() - 47 * HOUR) });
    const [ended] = await get().db.select().from(jobWatches).where(eq(jobWatches.id, w.id));
    expect(ended.endedAt).not.toBeNull();

    const w3 = await run((tx) => watchJob(me, tx, job.id, now));
    expect(w3.id).toBe(w1.id);
    const off = await run((tx) => unwatchJob(me, tx, job.id, now));
    expect(off?.endedAt).not.toBeNull();
    expect(await run((tx) => unwatchJob(me, tx, job.id, now))).toBeNull();
  });

  test("eligibilityFor picks the first sign-up position, else the first backup, else the first", async () => {
    const { job, positionIds } = await mkJob({
      positions: [
        { type: "Deputy Sheriff", count: 1 },
        { type: "CSO", count: 1 },
      ],
    });
    const cso = await person("CSO");
    const [deputyPos, csoPos] = positionIds;
    const r1 = await run((tx) => eligibilityFor(cso, tx, job.id));
    expect(r1.jobPositionId).toBe(csoPos);
    expect(r1.canSignUp).toBe(true);
    expect(r1.backupPosition).toBe(0);

    await sign(await person("Deputy Sheriff"), csoPos);
    const r2 = await run((tx) => eligibilityFor(cso, tx, job.id));
    expect(r2.jobPositionId).toBe(csoPos);
    expect(r2.canSignUp).toBe(false);
    expect(r2.canBackup).toBe(true);
    expect(r2.backupPosition).toBe(1);

    const posse = await person("Posse");
    const r3 = await run((tx) => eligibilityFor(posse, tx, job.id));
    expect(r3.jobPositionId).toBe(deputyPos);
    expect(r3.canSignUp).toBe(false);
    expect(r3.canBackup).toBe(false);
    expect(r3.checks.some((c) => c.check === "rank" && !c.ok)).toBe(true);
  });

  describe("fix round 1", () => {
    const flex = { earliest: [17, 0] as [number, number], latest: [24, 0] as [number, number], allowShorter: true };
    const vendorActor = async () => {
      const { actor } = await makeUser(get().db, "vendor", `su${userSeq++}@example.test`);
      return { ...actor, vendorId } as Actor;
    };

    test("vendors are refused on backup, watch and changing times", async () => {
      const { job, positionId, at } = await mkJob({ flex });
      const v = await vendorActor();
      await expect(run((tx) => joinBackup(v, tx, positionId, warning))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run((tx) => watchJob(v, tx, job.id))).rejects.toBeInstanceOf(ForbiddenError);
      const a = await sign(await person(), positionId, { now: new Date(job.startAt.getTime() - 48 * HOUR) });
      await expect(
        run((tx) => changePlannedTimes(v, tx, a.id, { startAt: at(17, 0), endAt: at(23, 0) }, new Date(job.startAt.getTime() - 48 * HOUR))),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("a coordinator cannot change someone else's planned times", async () => {
      const { job, positionId, at } = await mkJob({ flex });
      const now = new Date(job.startAt.getTime() - 48 * HOUR);
      const a = await sign(await person(), positionId, { now });
      await expect(
        run((tx) => changePlannedTimes(coord, tx, a.id, { startAt: at(17, 15), endAt: at(23, 15) }, now)),
      ).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("sign-up and backup are refused once the detail has started", async () => {
      const { job, positionId } = await mkJob();
      const after = new Date(job.startAt.getTime() + HOUR);
      const checks = await violation(sign(await person(), positionId, { now: after }));
      expect(checks.map((c) => c.message)).toContain("This detail has started");
      await sign(await person(), positionId, { now: new Date(job.startAt.getTime() - HOUR) });
      const backup = await violation(run(async (tx) => joinBackup(await person(), tx, positionId, { ...warning, now: after })));
      expect(backup.map((c) => c.message)).toContain("This detail has started");
    });

    test("pending to full length takes a spot only if one is free", async () => {
      const early = new Date(0);
      const free = await mkJob({ flex });
      early.setTime(free.job.startAt.getTime() - 72 * HOUR);
      const me = await person();
      const p = await sign(me, free.positionId, { now: early, plannedStartAt: free.at(18, 0), plannedEndAt: free.at(23, 0) });
      expect(p.status).toBe("pending_short");
      const changed = await run((tx) => changePlannedTimes(me, tx, p.id, { startAt: free.at(17, 0), endAt: free.at(23, 0) }, early));
      expect(changed.status).toBe("signed_up");

      const full = await mkJob({ flex });
      const t = new Date(full.job.startAt.getTime() - 72 * HOUR);
      const other = await person();
      const q = await sign(other, full.positionId, { now: t, plannedStartAt: full.at(18, 0), plannedEndAt: full.at(23, 0) });
      await sign(await person(), full.positionId, { now: new Date(t.getTime() + HOUR) });
      const checks = await violation(run((tx) => changePlannedTimes(other, tx, q.id, { startAt: full.at(17, 0), endAt: full.at(23, 0) }, t)));
      expect(checks.map((c) => c.message)).toContain("This position is full");
    });

    test("the tick declines pending requests on a started job", async () => {
      const { job, positionId, at } = await mkJob({ flex });
      const me = await person();
      const p = await sign(me, positionId, {
        now: new Date(job.startAt.getTime() - 72 * HOUR),
        plannedStartAt: at(18, 0),
        plannedEndAt: at(23, 0),
      });
      await run((tx) => confirmPendingShortTick(new Date(job.startAt.getTime() + HOUR), tx));
      expect((await get().db.select().from(assignments).where(eq(assignments.id, p.id)))[0].status).toBe("canceled");
      const [note] = await get().db.select().from(notifications).where(eq(notifications.userId, me.userId));
      expect(note.body).toBe("This detail has started");
    });

    test("without a scheduled tick, a sign-up after the window opens still lets the older pending request go first", async () => {
      const { job, positionId, at } = await mkJob({ flex });
      const older = await person();
      const p = await sign(older, positionId, {
        now: new Date(job.startAt.getTime() - 72 * HOUR),
        plannedStartAt: at(18, 0),
        plannedEndAt: at(23, 0),
      });
      const checks = await violation(sign(await person(), positionId, { now: new Date(job.startAt.getTime() - 23 * HOUR) }));
      expect(checks.map((c) => c.message)).toContain("This position is full");
      // The refused request rolls back with its transaction, so the older request is settled by the next tick.
      await run((tx) => confirmPendingShortTick(new Date(job.startAt.getTime() - 22 * HOUR), tx));
      expect((await get().db.select().from(assignments).where(eq(assignments.id, p.id)))[0].status).toBe("signed_up");
    });

    test("a successful sign-up after the window opens settles older pending requests first", async () => {
      const { job, positionId, at } = await mkJob({ flex, positions: [{ type: "Deputy Sheriff", count: 2 }] });
      const p = await sign(await person(), positionId, {
        now: new Date(job.startAt.getTime() - 72 * HOUR),
        plannedStartAt: at(18, 0),
        plannedEndAt: at(23, 0),
      });
      const mine = await sign(await person(), positionId, { now: new Date(job.startAt.getTime() - 23 * HOUR) });
      expect(mine.status).toBe("signed_up");
      expect((await get().db.select().from(assignments).where(eq(assignments.id, p.id)))[0].status).toBe("signed_up");
    });

    test("a concurrent duplicate sign-up by one person returns already_on_job", async () => {
      const { job, positionId } = await mkJob({ positions: [{ type: "Deputy Sheriff", count: 2 }] });
      const me = await person();
      const now = new Date(job.startAt.getTime() - 48 * HOUR);
      const results = await Promise.allSettled([sign(me, positionId, { now }), sign(me, positionId, { now })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const bad = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect(bad.reason).toBeInstanceOf(RuleViolation);
      expect((bad.reason as RuleViolation).checks).toContainEqual({ check: "already_on_job", ok: false, message: "You are already on this detail" });
    });

    test("two concurrent sign-ups by one person on overlapping jobs yield exactly one success", async () => {
      const day = nextDay();
      const a = await mkJob({ day, start: [17, 0], end: [23, 0] });
      const b = await mkJob({ day, start: [18, 0], end: [23, 30] });
      const me = await person();
      const now = new Date(a.job.startAt.getTime() - 48 * HOUR);
      const results = await Promise.allSettled([sign(me, a.positionId, { now }), sign(me, b.positionId, { now })]);
      expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
      const bad = results.find((r): r is PromiseRejectedResult => r.status === "rejected")!;
      expect((bad.reason as RuleViolation).checks.map((c) => c.check)).toContain("overlap");
    });

    test("a watch ended by sign-up is audited as the person", async () => {
      const { job, positionId } = await mkJob();
      const me = await person();
      const now = new Date(job.startAt.getTime() - 48 * HOUR);
      const w = await run((tx) => watchJob(me, tx, job.id, now));
      await sign(me, positionId, { now });
      const log = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, w.id), eq(auditLog.action, "job.watch_end")));
      expect(log).toHaveLength(1);
      expect(log[0].actorUserId).toBe(me.userId);
    });
  });
});
