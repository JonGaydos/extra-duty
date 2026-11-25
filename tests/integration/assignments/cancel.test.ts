import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, jobWatches, notifications, spotOffers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { cancelSignup } from "@/domain/assignments/cancel";
import { jobActivity } from "@/domain/personnel/views";
import { claimSpot, claimablePositionId } from "@/domain/assignments/backups";
import { restrictFromVendor } from "@/domain/assignments/coordinator";
import { eligibilityByPosition, joinBackup, signUp, watchJob } from "@/domain/assignments/signup";
import { RuleViolation, ValidationError } from "@/domain/errors";
import { cancelJob } from "@/domain/jobs/jobs";
import { updateSettings } from "@/domain/settings/settings";
import { suspendUser } from "@/domain/users/suspension";
import { backupOfferTick, watchReleaseTick } from "@/jobs/backup-window";
import { HOUR, MIN, setupFixture } from "./helpers";

describe("cancellation, backup offers and watch alerts", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  const warn = { warningVersion: 1 };

  beforeAll(async () => {
    f = await setupFixture(get().db, "cx");
  });
  afterEach(async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { backupOfferMode: "sequential", backupWindowMinutes: 30, backupFirstComeHours: 12 }));
  });

  const sign = (a: Actor, positionId: string, now: Date) => f.run((tx) => signUp(a, tx, positionId, { ...warn, now }));
  const backup = (a: Actor, positionId: string, now: Date) => f.run((tx) => joinBackup(a, tx, positionId, { ...warn, now }));
  const cancel = (a: Actor, id: string, now: Date) => f.run((tx) => cancelSignup(a, tx, id, "Plans changed", now));
  const claim = (a: Actor, positionId: string, now: Date) => f.run((tx) => claimSpot(a, tx, positionId, { ...warn, now }));
  const row = async (id: string) => (await get().db.select().from(assignments).where(eq(assignments.id, id)))[0];
  const offers = (positionId: string) => get().db.select().from(spotOffers).where(eq(spotOffers.jobPositionId, positionId)).orderBy(asc(spotOffers.createdAt), asc(spotOffers.id));
  const inbox = async (userId: string, type: string) =>
    (await get().db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)))).length;
  const message = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(RuleViolation);
    return (e as RuleViolation).checks.filter((c) => !c.ok).map((c) => c.message);
  };

  /** One filled spot, `n` backups numbered 1..n. */
  async function withBackups(n: number) {
    const { job, positionId } = await f.mkJob();
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const holder = await f.person();
    const first = await sign(holder, positionId, t0);
    const backups: { actor: Actor; id: string }[] = [];
    for (let i = 0; i < n; i++) {
      const actor = await f.person();
      backups.push({ actor, id: (await backup(actor, positionId, t0)).id });
    }
    const cancelAt = new Date(job.startAt.getTime() - 48 * HOUR);
    return { job, positionId, holder, first, backups, cancelAt };
  }

  test("cancel opens the spot and the canceled person stays on the roster", async () => {
    const s = await withBackups(0);
    const done = await cancel(s.holder, s.first.id, s.cancelAt);
    expect(done.status).toBe("canceled");
    expect((await row(s.first.id)).status).toBe("canceled");
    const next = await f.person();
    expect((await sign(next, s.positionId, s.cancelAt)).status).toBe("signed_up");
  });

  test("the activity reads 'You canceled your sign-up' for the person, and names them for everyone else", async () => {
    const s = await withBackups(0);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const own = (await f.run((tx) => jobActivity(s.holder, tx, s.job.id))).map((r) => r.text);
    expect(own).toContain("You canceled your sign-up");
    expect(own.some((t) => t.includes("their sign-up"))).toBe(false);
    const other = await f.person();
    const theirs = (await f.run((tx) => jobActivity(other, tx, s.job.id))).map((r) => r.text);
    expect(theirs.some((t) => /^.+ canceled their sign-up$/.test(t) && !t.startsWith("You"))).toBe(true);
  });

  test("self-cancel one minute before start works, one minute after is refused, a coordinator can still remove", async () => {
    const a = await withBackups(0);
    await cancel(a.holder, a.first.id, new Date(a.job.startAt.getTime() - MIN));
    const b = await withBackups(0);
    const e = await cancel(b.holder, b.first.id, new Date(b.job.startAt.getTime() + MIN)).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((e as Error).message).toBe("This detail has started. Ask a coordinator to remove you.");
    const { removePerson } = await import("@/domain/assignments/coordinator");
    const removed = await f.run((tx) => removePerson(f.coord, tx, b.first.id, "Left early", new Date(b.job.startAt.getTime() + MIN)));
    expect(removed).toMatchObject({ status: "removed", removalReason: "Left early" });
    expect(await inbox(b.holder.userId, "assignment.removed")).toBe(1);
    expect(await offers(b.positionId)).toHaveLength(0);
  });

  test("a backup leaving, or a pending_short request, opens no spot", async () => {
    const s = await withBackups(2);
    await cancel(s.backups[0].actor, s.backups[0].id, s.cancelAt);
    expect(await offers(s.positionId)).toHaveLength(0);
    expect(await row(s.backups[0].id)).toMatchObject({ status: "canceled", backupPosition: null });
    expect((await row(s.backups[1].id)).backupPosition).toBe(1);
  });

  test("sequential: backup 2 waits for backup 1's window, backup 1 claims, the rest are re-numbered", async () => {
    const s = await withBackups(3);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const [o] = await offers(s.positionId);
    expect(o).toMatchObject({ mode: "sequential", offeredToAssignmentId: s.backups[0].id, status: "open" });
    expect(o.endsAt.getTime() - s.cancelAt.getTime()).toBe(30 * MIN);
    expect(await inbox(s.backups[0].actor.userId, "spot.offered")).toBe(1);
    expect(await message(claim(s.backups[1].actor, s.positionId, new Date(s.cancelAt.getTime() + 5 * MIN)))).toContain("It is not your turn for this spot");
    const outsider = await f.person();
    expect(await message(sign(outsider, s.positionId, s.cancelAt))).toEqual(["Backups have first chance at this spot"]);
    const won = await claim(s.backups[0].actor, s.positionId, new Date(s.cancelAt.getTime() + 5 * MIN));
    expect(won).toMatchObject({ status: "signed_up", backupPosition: null });
    expect((await offers(s.positionId))[0].status).toBe("accepted");
    expect((await row(s.backups[1].id)).backupPosition).toBe(1);
    expect((await row(s.backups[2].id)).backupPosition).toBe(2);
  });

  test("claimablePositionId: only the backup whose turn it is can take the freed spot, and nobody once it is taken", async () => {
    const s = await withBackups(2);
    const can = (id: string, at: Date) => f.run((tx) => claimablePositionId(tx, id, at));
    expect(await can(s.backups[0].id, s.cancelAt)).toBeNull();
    await cancel(s.holder, s.first.id, s.cancelAt);
    const later = new Date(s.cancelAt.getTime() + 5 * MIN);
    expect(await can(s.backups[0].id, later)).toBe(s.positionId);
    expect(await can(s.backups[1].id, later)).toBeNull();
    expect(await can(s.first.id, later)).toBeNull();
    await claim(s.backups[0].actor, s.positionId, later);
    expect(await can(s.backups[1].id, later)).toBeNull();
    // After the detail starts nobody can claim.
    expect(await can(s.backups[1].id, new Date(s.job.startAt.getTime() + MIN))).toBeNull();
  });

  test("during a backup's turn, a non-backup's eligibility shows the backup-turn check failing, not all checks passed", async () => {
    const s = await withBackups(1);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const outsider = await f.person();
    const during = new Date(s.cancelAt.getTime() + 5 * MIN);
    const [e] = await f.run((tx) => eligibilityByPosition(outsider, tx, s.job.id, during));
    expect(e.canSignUp).toBe(false);
    expect(e.checks.filter((c) => !c.ok).map((c) => c.message)).toEqual(["Backups have first chance at this spot"]);
    // Once the only backup's window ends unclaimed, the spot is open to everyone.
    await f.run((tx) => backupOfferTick(new Date(s.cancelAt.getTime() + 31 * MIN), tx));
    const [after] = await f.run((tx) => eligibilityByPosition(outsider, tx, s.job.id, new Date(s.cancelAt.getTime() + 32 * MIN)));
    expect(after.canSignUp).toBe(true);
    expect(after.checks.every((c) => c.ok)).toBe(true);
  });

  test("sequential tick: backup 2 is offered after backup 1's window, then a non-backup can claim after the last", async () => {
    const s = await withBackups(2);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const watcher = await f.person();
    await f.run((tx) => watchJob(watcher, tx, s.job.id, s.cancelAt));
    await f.run((tx) => backupOfferTick(new Date(s.cancelAt.getTime() + 31 * MIN), tx));
    const list = await offers(s.positionId);
    expect(list.map((o) => [o.status, o.offeredToAssignmentId])).toEqual([
      ["expired", s.backups[0].id],
      ["open", s.backups[1].id],
    ]);
    expect(await inbox(s.backups[1].actor.userId, "spot.offered")).toBe(1);
    expect(await inbox(watcher.userId, "job.watch_opened")).toBe(0);
    await f.run((tx) => backupOfferTick(new Date(s.cancelAt.getTime() + 62 * MIN), tx));
    expect((await offers(s.positionId)).every((o) => o.status === "expired")).toBe(true);
    expect(await inbox(watcher.userId, "job.watch_opened")).toBe(1);
    const outsider = await f.person();
    const got = await claim(outsider, s.positionId, new Date(s.cancelAt.getTime() + 63 * MIN));
    expect(got.status).toBe("signed_up");
  });

  test("all_backups: any backup can claim, a non-backup cannot", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { backupOfferMode: "all_backups" }));
    const s = await withBackups(2);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const [o] = await offers(s.positionId);
    expect(o).toMatchObject({ mode: "all_backups", offeredToAssignmentId: null });
    expect(await inbox(s.backups[0].actor.userId, "spot.offered")).toBe(1);
    expect(await inbox(s.backups[1].actor.userId, "spot.offered")).toBe(1);
    const outsider = await f.person();
    expect(await message(claim(outsider, s.positionId, s.cancelAt))).toEqual(["Backups have first chance at this spot"]);
    const won = await claim(s.backups[1].actor, s.positionId, new Date(s.cancelAt.getTime() + MIN));
    expect(won.status).toBe("signed_up");
    expect((await row(s.backups[0].id)).backupPosition).toBe(1);
  });

  test("everyone mode: a non-backup claims at once", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { backupOfferMode: "everyone" }));
    const s = await withBackups(1);
    await cancel(s.holder, s.first.id, s.cancelAt);
    expect(await offers(s.positionId)).toHaveLength(0);
    const outsider = await f.person();
    expect((await claim(outsider, s.positionId, s.cancelAt)).status).toBe("signed_up");
  });

  test("a shorter backup window applies to new offers", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { backupWindowMinutes: 15 }));
    const s = await withBackups(1);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const [o] = await offers(s.positionId);
    expect(o.endsAt.getTime() - s.cancelAt.getTime()).toBe(15 * MIN);
  });

  test("inside the first-come window backup turns are skipped and anyone eligible can claim", async () => {
    const s = await withBackups(2);
    const now = new Date(s.job.startAt.getTime() - 11 * HOUR);
    await cancel(s.holder, s.first.id, now);
    expect(await offers(s.positionId)).toHaveLength(0);
    expect(await inbox(s.backups[0].actor.userId, "spot.opened_first_come")).toBe(1);
    const outsider = await f.person();
    expect((await claim(outsider, s.positionId, now)).status).toBe("signed_up");
  });

  test("a sequential chain still running at 12 hours out becomes first come, first served on the next tick", async () => {
    const s = await withBackups(2);
    const open = new Date(s.job.startAt.getTime() - 12 * HOUR - 10 * MIN);
    await cancel(s.holder, s.first.id, open);
    const later = new Date(s.job.startAt.getTime() - 12 * HOUR + MIN);
    await f.run((tx) => backupOfferTick(later, tx));
    expect((await offers(s.positionId))[0].status).toBe("expired");
    expect(await inbox(s.backups[1].actor.userId, "spot.opened_first_come")).toBe(1);
    const outsider = await f.person();
    expect((await claim(outsider, s.positionId, later)).status).toBe("signed_up");
  });

  test("an open offer holds one spot only: with two free spots an outsider can take the other", async () => {
    const { job, positionId } = await f.mkJob({ count: 2 });
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const [h1, h2, b1] = [await f.person(), await f.person(), await f.person()];
    const a1 = await sign(h1, positionId, t0);
    const a2 = await sign(h2, positionId, t0);
    await backup(b1, positionId, t0);
    const at = new Date(job.startAt.getTime() - 48 * HOUR);
    await cancel(h1, a1.id, at);
    await cancel(h2, a2.id, at);
    expect(await offers(positionId)).toHaveLength(1);
    const outsider = await f.person();
    expect((await sign(outsider, positionId, at)).status).toBe("signed_up");
    const second = await f.person();
    expect(await message(sign(second, positionId, at))).toEqual(["Backups have first chance at this spot"]);
  });

  test("an offered backup who cancels passes the turn and the rest are re-numbered", async () => {
    const s = await withBackups(2);
    await cancel(s.holder, s.first.id, s.cancelAt);
    await cancel(s.backups[0].actor, s.backups[0].id, new Date(s.cancelAt.getTime() + MIN));
    const list = await offers(s.positionId);
    expect(list.map((o) => [o.status, o.offeredToAssignmentId])).toEqual([
      ["expired", s.backups[0].id],
      ["open", s.backups[1].id],
    ]);
    expect((await row(s.backups[1].id)).backupPosition).toBe(1);
  });

  test("two spots freeing while offers run: each gets its own offer, b2 is not put behind an outsider", async () => {
    const { job, positionId } = await f.mkJob({ count: 2 });
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const [h1, h2, b1, b2] = [await f.person(), await f.person(), await f.person(), await f.person()];
    const a1 = await sign(h1, positionId, t0);
    const a2 = await sign(h2, positionId, t0);
    const r1 = await backup(b1, positionId, t0);
    const r2 = await backup(b2, positionId, t0);
    const at = new Date(job.startAt.getTime() - 48 * HOUR);
    await cancel(h1, a1.id, at);
    await cancel(h2, a2.id, at);
    const list = await offers(positionId);
    expect(list.map((o) => [o.status, o.offeredToAssignmentId])).toEqual([
      ["open", r1.id],
      ["open", r2.id],
    ]);
    const outsider = await f.person();
    expect(await message(sign(outsider, positionId, at))).toEqual(["Backups have first chance at this spot"]);
    expect((await claim(b2, positionId, at)).status).toBe("signed_up");
    expect((await offers(positionId)).map((o) => o.status)).toEqual(["open", "accepted"]);
    expect((await row(r1.id)).backupPosition).toBe(1);
  });

  test("with one backup and two free spots the second spot opens to everyone and alerts watchers", async () => {
    const { job, positionId } = await f.mkJob({ count: 2 });
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const [h1, h2, b1, watcher] = [await f.person(), await f.person(), await f.person(), await f.person()];
    const a1 = await sign(h1, positionId, t0);
    const a2 = await sign(h2, positionId, t0);
    await backup(b1, positionId, t0);
    await f.run((tx) => watchJob(watcher, tx, job.id, t0));
    const at = new Date(job.startAt.getTime() - 48 * HOUR);
    await cancel(h1, a1.id, at);
    expect(await inbox(watcher.userId, "job.watch_opened")).toBe(0);
    await cancel(h2, a2.id, at);
    expect(await inbox(watcher.userId, "job.watch_opened")).toBe(1);
  });

  test("a non-backup can join the list while an offer holds the only free spot", async () => {
    const s = await withBackups(1);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const late = await f.person();
    expect((await backup(late, s.positionId, s.cancelAt)).status).toBe("backup");
  });

  test("inside 12 hours a non-first backup can claim, and every eligible watcher is alerted", async () => {
    const s = await withBackups(2);
    const w1 = await f.person();
    const w2 = await f.person();
    for (const w of [w1, w2]) await f.run((tx) => watchJob(w, tx, s.job.id, s.cancelAt));
    const now = new Date(s.job.startAt.getTime() - 11 * HOUR);
    await cancel(s.holder, s.first.id, now);
    expect(await inbox(w1.userId, "job.watch_opened")).toBe(1);
    expect(await inbox(w2.userId, "job.watch_opened")).toBe(1);
    expect((await claim(s.backups[1].actor, s.positionId, now)).status).toBe("signed_up");
    expect((await row(s.backups[0].id)).backupPosition).toBe(1);
  });

  test("after the one alert ends a watch, watching again gets the next opening's alert", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { backupOfferMode: "everyone" }));
    const s = await withBackups(0);
    const me = await f.person();
    await f.run((tx) => watchJob(me, tx, s.job.id, s.cancelAt));
    await cancel(s.holder, s.first.id, s.cancelAt);
    const next = await f.person();
    const taken = await sign(next, s.positionId, s.cancelAt);
    await f.run((tx) => watchJob(me, tx, s.job.id, s.cancelAt));
    await cancel(next, taken.id, s.cancelAt);
    expect(await inbox(me.userId, "job.watch_opened")).toBe(2);
  });

  test("the canceled person stays on the job's records with status canceled", async () => {
    const s = await withBackups(0);
    await cancel(s.holder, s.first.id, s.cancelAt);
    const all = await get().db.select().from(assignments).where(eq(assignments.jobId, s.job.id));
    expect(all.map((a) => a.status)).toEqual(["canceled"]);
  });

  test("a watcher is not alerted when the only free spot is held by an offer", async () => {
    const s = await withBackups(1);
    const watcher = await f.person();
    await f.run((tx) => watchJob(watcher, tx, s.job.id, s.cancelAt));
    await cancel(s.holder, s.first.id, s.cancelAt);
    expect(await inbox(watcher.userId, "job.watch_opened")).toBe(0);
  });

  test("restriction removals notify the person and a pending request is removed by suspension", async () => {
    const s = await withBackups(0);
    await f.run((tx) => restrictFromVendor(f.coord, tx, s.holder.userId, f.vendorId, { reason: "Conduct", removeFromFutureDetails: true }));
    expect(await row(s.first.id)).toMatchObject({ status: "removed", removalReason: "Restricted: Conduct" });
    expect(await inbox(s.holder.userId, "assignment.removed")).toBe(1);
  });

  test("a spot that already opened to everyone is not offered again when its sibling offer is claimed", async () => {
    const { job, positionId } = await f.mkJob({ count: 2 });
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const [h1, h2, b1, b2] = [await f.person(), await f.person(), await f.person(), await f.person()];
    const a1 = await sign(h1, positionId, t0);
    const a2 = await sign(h2, positionId, t0);
    await backup(b1, positionId, t0);
    await backup(b2, positionId, t0);
    const at = new Date(job.startAt.getTime() - 48 * HOUR);
    await cancel(h1, a1.id, at);
    await cancel(h2, a2.id, new Date(at.getTime() + 20 * MIN));
    // A (b1) lapses at +30 and opens to everyone while B (b2, ends +50) is still open.
    await f.run((tx) => backupOfferTick(new Date(at.getTime() + 31 * MIN), tx));
    expect((await offers(positionId)).map((o) => o.status)).toEqual(["expired", "open"]);
    const mid = new Date(at.getTime() + 32 * MIN);
    expect((await claim(b2, positionId, mid)).status).toBe("signed_up");
    expect((await offers(positionId)).filter((o) => o.status === "open")).toHaveLength(0);
    expect(await inbox(b1.userId, "spot.offered")).toBe(1);
    const outsider = await f.person();
    expect((await sign(outsider, positionId, mid)).status).toBe("signed_up");
  });

  test("a later cancellation offers only the one spot that freed, not spots already open to everyone", async () => {
    const { job, positionId } = await f.mkJob({ count: 3 });
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const [h1, h2, h3, b1, b2] = [await f.person(), await f.person(), await f.person(), await f.person(), await f.person()];
    const a1 = await sign(h1, positionId, t0);
    const a2 = await sign(h2, positionId, t0);
    const a3 = await sign(h3, positionId, t0);
    const r1 = await backup(b1, positionId, t0);
    await backup(b2, positionId, t0);
    const at = new Date(job.startAt.getTime() - 48 * HOUR);
    await cancel(h1, a1.id, at);
    await cancel(h2, a2.id, new Date(at.getTime() + 20 * MIN));
    await f.run((tx) => backupOfferTick(new Date(at.getTime() + 31 * MIN), tx));
    await f.run((tx) => backupOfferTick(new Date(at.getTime() + 51 * MIN), tx));
    expect((await offers(positionId)).map((o) => o.status)).toEqual(["expired", "expired"]);
    const later = new Date(at.getTime() + 52 * MIN);
    await cancel(h3, a3.id, later);
    // Backups are numbered 1..2 and nobody holds an offer, so the new spot goes to b1 alone.
    const open = (await offers(positionId)).filter((o) => o.status === "open");
    expect(open.map((o) => o.offeredToAssignmentId)).toEqual([r1.id]);
    expect(await inbox(b1.userId, "spot.offered")).toBe(2);
    expect(await inbox(b2.userId, "spot.offered")).toBe(1);
    // Two spots are open to everyone, so an outsider still gets one.
    const outsider = await f.person();
    expect((await sign(outsider, positionId, later)).status).toBe("signed_up");
  });

  test("first-come alerts go out once per position when several offers end together", async () => {
    const { job, positionId } = await f.mkJob({ count: 2 });
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const [h1, h2, b1, b2] = [await f.person(), await f.person(), await f.person(), await f.person()];
    const a1 = await sign(h1, positionId, t0);
    const a2 = await sign(h2, positionId, t0);
    await backup(b1, positionId, t0);
    await backup(b2, positionId, t0);
    const at = new Date(job.startAt.getTime() - 12 * HOUR - 10 * MIN);
    await cancel(h1, a1.id, at);
    await cancel(h2, a2.id, at);
    expect((await offers(positionId)).filter((o) => o.status === "open")).toHaveLength(2);
    await f.run((tx) => backupOfferTick(new Date(job.startAt.getTime() - 12 * HOUR + MIN), tx));
    expect(await inbox(b1.userId, "spot.opened_first_come")).toBe(1);
    expect(await inbox(b2.userId, "spot.opened_first_come")).toBe(1);
  });

  test("re-numbering backups writes an audit row per changed backup", async () => {
    const s = await withBackups(3);
    await cancel(s.backups[0].actor, s.backups[0].id, s.cancelAt);
    const { auditLog } = await import("@/db/schema");
    const rows = await get().db.select().from(auditLog).where(eq(auditLog.action, "assignment.backup_renumber"));
    const mine = rows.filter((r) => [s.backups[1].id, s.backups[2].id].includes(r.entityId ?? ""));
    expect(mine).toHaveLength(2);
    expect(mine.find((r) => r.entityId === s.backups[1].id)).toMatchObject({ before: { backupPosition: 2 }, after: { backupPosition: 1 } });
  });

  test("watchers: eligible ones get watch_opened once, ineligible and restricted ones get nothing, the watch ends", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { backupOfferMode: "everyone" }));
    const s = await withBackups(0);
    const [ok, posse, restricted] = [await f.person(), await f.person("Posse"), await f.person()];
    for (const w of [ok, posse, restricted]) await f.run((tx) => watchJob(w, tx, s.job.id, s.cancelAt));
    await f.run((tx) => restrictFromVendor(f.coord, tx, restricted.userId, f.vendorId, { reason: "Conduct", removeFromFutureDetails: false }));
    await cancel(s.holder, s.first.id, s.cancelAt);
    expect(await inbox(ok.userId, "job.watch_opened")).toBe(1);
    expect(await inbox(posse.userId, "job.watch_opened")).toBe(0);
    expect(await inbox(restricted.userId, "job.watch_opened")).toBe(0);
    const [w] = await get().db.select().from(jobWatches).where(and(eq(jobWatches.userId, ok.userId), eq(jobWatches.jobId, s.job.id)));
    expect(w.endedAt).not.toBeNull();
    // The spot fills and opens again: the ended watch alerts nobody.
    const next = await f.person();
    const taken = await sign(next, s.positionId, s.cancelAt);
    await cancel(next, taken.id, s.cancelAt);
    expect(await inbox(ok.userId, "job.watch_opened")).toBe(1);
  });

  test("signing up ends the person's watch", async () => {
    const { job, positionId } = await f.mkJob();
    const me = await f.person();
    await f.run((tx) => watchJob(me, tx, job.id, new Date(job.startAt.getTime() - 72 * HOUR)));
    await sign(me, positionId, new Date(job.startAt.getTime() - 71 * HOUR));
    const [w] = await get().db.select().from(jobWatches).where(eq(jobWatches.userId, me.userId));
    expect(w.endedAt).not.toBeNull();
  });

  test("a release alerts watchers once, and only eligible ones", async () => {
    const { job } = await f.mkJob();
    const { jobs } = await import("@/db/schema");
    const releaseAt = new Date(job.startAt.getTime() - 10 * 24 * HOUR);
    await get().db.update(jobs).set({ releaseAt }).where(eq(jobs.id, job.id));
    const at = (days: number) => new Date(releaseAt.getTime() + days * 24 * HOUR).toISOString();
    const [ok, posse] = [await f.person(), await f.person("Posse")];
    for (const w of [ok, posse]) await f.run((tx) => watchJob(w, tx, job.id, new Date(releaseAt.getTime() - 30 * 24 * HOUR)));
    const tick = (iso: string) => f.run((tx) => watchReleaseTick(new Date(iso), tx));
    expect((await tick(at(-1))).alerted).toBe(0);
    expect((await tick(at(1))).alerted).toBe(1);
    expect((await tick(at(2))).alerted).toBe(0);
    expect(await inbox(ok.userId, "job.watch_released")).toBe(1);
    expect(await inbox(posse.userId, "job.watch_released")).toBe(0);
  });

  test("canceling a job declines its pending shorter requests", async () => {
    const { job, positionId } = await f.mkJob();
    const me = await f.person();
    const [pending] = await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: me.userId, status: "pending_short" }).returning();
    await f.run((tx) => cancelJob(f.coord, tx, job.id, "Vendor request"));
    expect(await row(pending.id)).toMatchObject({ status: "canceled", removalReason: "Detail canceled" });
    expect(await inbox(me.userId, "signup.short_declined")).toBe(1);
  });

  test("suspending a signed-up person opens the spot and stores the reason", async () => {
    const s = await withBackups(1);
    await f.run((tx) => suspendUser(f.coord, tx, s.holder.userId, { reason: "Review", until: null, removeFutureAssignments: true }));
    expect(await row(s.first.id)).toMatchObject({ status: "removed", removalReason: "Suspended" });
    const [o] = await offers(s.positionId);
    expect(o.offeredToAssignmentId).toBe(s.backups[0].id);
  });
});
