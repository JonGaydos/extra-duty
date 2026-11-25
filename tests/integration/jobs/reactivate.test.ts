import { describe, expect, test } from "vitest";
import { and, asc, eq, inArray } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, invoices, jobSeries, jobs, notifications, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { cancelSignup } from "@/domain/assignments/cancel";
import { joinBackup, signUp } from "@/domain/assignments/signup";
import { recommendationsFor } from "@/domain/planning/recommend";
import { setEarningsGoal } from "@/domain/planning/preferences";
import { loadUnbilled } from "@/domain/billing/lock";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { cancelJob, getJob, listJobs, reactivateJob, reactivationPreview } from "@/domain/jobs/jobs";
import { jobAdmin } from "@/domain/coordinator/views";
import { jobActivity, myDetails } from "@/domain/personnel/views";
import { isReleased, releaseAt } from "@/domain/release/release";
import { getSettings } from "@/domain/settings/settings";
import { AGENCY_TZ } from "@/domain/time/agency-time";
import { vendorViewJob } from "@/domain/vendor-portal/requests";
import { makeUser } from "../users/helpers";
import { HOUR, setupFixture } from "../assignments/helpers";

const day = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, dateStyle: "medium" }).format(d);
const REASON = "Canceled the wrong date";
const WHY = "Vendor changed its mind";

describe("reactivate a canceled detail", () => {
  const get = useTestDb();
  useEmailQueue(get);

  const rows = (jobId: string) => get().db.select().from(assignments).where(eq(assignments.jobId, jobId)).orderBy(asc(assignments.createdAt), asc(assignments.id));
  const alerts = (jobId: string, type: string) => get().db.select().from(notifications).where(and(eq(notifications.type, type), eq(notifications.link, `/jobs/${jobId}`)));
  const ruleMessage = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(RuleViolation);
    return (e as RuleViolation).checks.filter((c) => !c.ok).map((c) => c.message);
  };

  /** A released two-spot detail with two deputies signed up and one backup, canceled by a coordinator (not late). */
  async function canceledDetail(prefix: string) {
    const f = await setupFixture(get().db, prefix);
    const { job, positionId } = await f.mkJob({ count: 2 });
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const a = await f.person();
    const b = await f.person();
    const c = await f.person();
    await f.run((tx) => signUp(a, tx, positionId, { warningVersion: 1, now: t0 }));
    await f.run((tx) => signUp(b, tx, positionId, { warningVersion: 1, now: t0 }));
    await f.run((tx) => joinBackup(c, tx, positionId, { warningVersion: 1, now: t0 }));
    const cancelAt = new Date(job.startAt.getTime() - 48 * HOUR);
    await f.run((tx) => cancelJob(f.coord, tx, job.id, REASON, { now: cancelAt }));
    const vendor = await makeUser(get().db, "vendor", `${prefix}-vendor@example.test`);
    await get().db.insert(vendorUsers).values({ userId: vendor.row.id, vendorId: f.vendorId });
    const vendorActor: Actor = { ...vendor.actor, vendorId: f.vendorId };
    return { f, job, positionId, a, b, c, t0, cancelAt, vendor: vendorActor, now: new Date(job.startAt.getTime() - 24 * HOUR) };
  }

  test("a coordinator reactivates with a reason: the detail is scheduled and released again, the cancel stays on record", async () => {
    const s = await canceledDetail("ra1");
    const done = await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, `  ${WHY}  `, s.now));
    expect(done.state).toBe("scheduled");
    expect(isReleased(done, s.now)).toBe(true);
    // The cancel fields stay: the late cancellation pay window is counted from canceledAt.
    expect(done.canceledAt).toEqual(s.cancelAt);
    const [audit] = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "job.reactivate"), eq(auditLog.entityId, s.job.id)));
    expect(audit.reason).toBe(WHY);
    expect(audit.actorUserId).toBe(s.f.coord.userId);
    expect(audit.before).toMatchObject({ state: "canceled" });
    expect(audit.after).toMatchObject({ state: "scheduled" });
    // The cancel audit is untouched.
    const [cancel] = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "job.cancel"), eq(auditLog.entityId, s.job.id)));
    expect(cancel.reason).toBe(REASON);
  });

  test("a waiver of the last cancel's late-cancel pay does not carry over to the next cancel", async () => {
    const s = await canceledDetail("ra-waive");
    await get().db.update(jobs).set({ lateCancelWaivedReason: "Vendor paid the deputies directly" }).where(eq(jobs.id, s.job.id));
    const done = await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    expect(done.lateCancelWaivedReason).toBeNull();
  });

  test("a missing reason is a ValidationError", async () => {
    const s = await canceledDetail("ra2");
    await expect(s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, "   ", s.now))).rejects.toBeInstanceOf(ValidationError);
    await expect(s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, undefined as unknown as string, s.now))).rejects.toBeInstanceOf(ValidationError);
  });

  test("personnel and the detail's vendor are forbidden; another vendor gets not found", async () => {
    const s = await canceledDetail("ra3");
    await expect(s.f.run((tx) => reactivateJob(s.a, tx, s.job.id, WHY, s.now))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(s.f.run((tx) => reactivateJob(s.vendor, tx, s.job.id, WHY, s.now))).rejects.toBeInstanceOf(ForbiddenError);
    const other = await makeUser(get().db, "vendor", "ra3-other@example.test");
    await expect(s.f.run((tx) => reactivateJob({ ...other.actor, vendorId: s.f.otherVendorId }, tx, s.job.id, WHY, s.now))).rejects.toBeInstanceOf(NotFoundError);
    await expect(s.f.run((tx) => reactivationPreview(s.a, tx, s.job.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await get().db.select().from(jobs).where(eq(jobs.id, s.job.id)))[0].state).toBe("canceled");
  });

  test("an ended detail and a detail that is not canceled each give a RuleViolation", async () => {
    const s = await canceledDetail("ra4");
    expect(await ruleMessage(s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.job.endAt)))).toEqual(["This detail has already ended"]);
    const { job } = await s.f.mkJob();
    expect(await ruleMessage(s.f.run((tx) => reactivateJob(s.f.coord, tx, job.id, WHY, s.now)))).toEqual(["Only a canceled detail can be reactivated"]);
  });

  test("a detail whose release time is still ahead waits for it, as configured now", async () => {
    const f = await setupFixture(get().db, "ra5");
    const { job } = await f.mkJob();
    // Never released: the release time was in the future when it was canceled.
    await get().db.update(jobs).set({ releaseAt: new Date(job.startAt.getTime() - HOUR) }).where(eq(jobs.id, job.id));
    await f.run((tx) => cancelJob(f.coord, tx, job.id, REASON));
    const settings = await f.run((tx) => getSettings(tx));
    const normal = releaseAt(job.startAt, settings);
    const now = new Date(normal.getTime() - 24 * HOUR);
    const done = await f.run((tx) => reactivateJob(f.coord, tx, job.id, WHY, now));
    expect(done.state).toBe("scheduled");
    expect(done.releaseAt).toEqual(normal);
    expect(isReleased(done, now)).toBe(false);
    expect(isReleased(done, normal)).toBe(true);
  });

  test("no sign-up is restored; a former deputy can sign up again; the old rows stay canceled", async () => {
    const s = await canceledDetail("ra6");
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    const after = await rows(s.job.id);
    expect(after.map((r) => r.status)).toEqual(["canceled", "canceled", "canceled"]);
    const again = await s.f.run((tx) => signUp(s.a, tx, s.positionId, { warningVersion: 1, now: s.now }));
    expect(again.status).toBe("signed_up");
    expect((await rows(s.job.id)).map((r) => r.status)).toEqual(["canceled", "canceled", "canceled", "signed_up"]);
  });

  test("the former deputies and the vendor are told, without the reason; someone who left before the cancel is not", async () => {
    const s = await canceledDetail("ra8");
    // A fourth person signed up and gave the spot away before the cancel: not on the detail when it was canceled.
    const { job, positionId } = await s.f.mkJob({ count: 1 });
    const early = await s.f.person();
    const on = await s.f.person();
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const mine = await s.f.run((tx) => signUp(early, tx, positionId, { warningVersion: 1, now: t0 }));
    await s.f.run((tx) => cancelSignup(early, tx, mine.id, "Plans changed", t0));
    await s.f.run((tx) => signUp(on, tx, positionId, { warningVersion: 1, now: t0 }));
    await s.f.run((tx) => cancelJob(s.f.coord, tx, job.id, REASON, { now: t0 }));
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, job.id, WHY, t0));
    const told = await alerts(job.id, "job.reactivated");
    expect(told.map((n) => n.userId).sort()).toEqual([on.userId, s.vendor.userId].sort());

    const preview = await s.f.run((tx) => reactivationPreview(s.f.coord, tx, s.job.id));
    expect(preview.notify.map((n) => n.userId).sort()).toEqual([s.a.userId, s.b.userId, s.c.userId].sort());
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    const sent = await alerts(s.job.id, "job.reactivated");
    const deputies = sent.filter((n) => n.userId !== s.vendor.userId);
    expect(deputies.map((n) => n.userId).sort()).toEqual([s.a.userId, s.b.userId, s.c.userId].sort());
    for (const n of deputies) expect(n.body).toBe(`Detail #${s.job.number} on ${day(s.job.startAt)} is back on. Sign up again if you still want it.`);
    const [toVendor] = sent.filter((n) => n.userId === s.vendor.userId);
    expect(toVendor.body).toBe(`Detail #${s.job.number} on ${day(s.job.startAt)} has been reactivated.`);
    for (const n of sent) {
      expect(`${n.title} ${n.body}`).not.toContain(WHY);
      expect(`${n.title} ${n.body}`).not.toContain(REASON);
    }
    expect(sent.map((n) => n.userId)).not.toContain(s.f.coord.userId);
  });

  test("personnel see it open again with no reasons; the vendor sees it scheduled; staff see both reasons", async () => {
    const s = await canceledDetail("ra9");
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    const [card] = await s.f.run((tx) => myDetails(s.a, tx, s.now));
    expect(card.job.id).toBe(s.job.id);
    expect(JSON.stringify(card)).not.toContain(REASON);
    expect(JSON.stringify(card)).not.toContain(WHY);
    const forDeputy = await s.f.run((tx) => jobActivity(s.a, tx, s.job.id));
    expect(JSON.stringify(forDeputy)).not.toContain(REASON);
    expect(JSON.stringify(forDeputy)).not.toContain(WHY);
    // Personnel are not told who canceled or reactivated it.
    expect(forDeputy.slice(0, 2).map((r) => r.text)).toEqual(["The detail was reactivated", "The detail was canceled"]);
    const view = await s.f.run((tx) => vendorViewJob(s.vendor, tx, s.job.id, s.now));
    expect(view.state).toBe("scheduled");
    const forStaff = await s.f.run((tx) => jobActivity(s.f.coord, tx, s.job.id));
    const events = forStaff.filter((r) => r.event).map((r) => [r.event!.kind, r.event!.reason]);
    expect(events).toEqual([
      ["reactivated", WHY],
      ["canceled", REASON],
    ]);
  });

  test("other details in a canceled series stay canceled", async () => {
    const f = await setupFixture(get().db, "ra10");
    const one = await f.mkJob();
    const two = await f.mkJob();
    const [series] = await get().db.insert(jobSeries).values({ name: "s" }).returning();
    for (const j of [one, two]) await get().db.update(jobs).set({ seriesId: series.id }).where(eq(jobs.id, j.job.id));
    for (const j of [one, two]) await f.run((tx) => cancelJob(f.coord, tx, j.job.id, REASON));
    await f.run((tx) => reactivateJob(f.coord, tx, one.job.id, WHY, new Date(one.job.startAt.getTime() - HOUR)));
    const states = await get().db.select({ id: jobs.id, state: jobs.state }).from(jobs).where(eq(jobs.seriesId, series.id));
    expect(Object.fromEntries(states.map((r) => [r.id, r.state]))).toEqual({ [one.job.id]: "scheduled", [two.job.id]: "canceled" });
  });

  test("cancel reason, time and vendor flag are hidden from personnel and vendors unless the detail is canceled now; staff always see them", async () => {
    const s = await canceledDetail("ra14");
    const window = { from: new Date(s.job.startAt.getTime() - HOUR), to: new Date(s.job.startAt.getTime() + HOUR) };
    const pick = (j: { cancelReason: string | null; canceledAt: Date | null; canceledByVendor: boolean }) => ({ cancelReason: j.cancelReason, canceledAt: j.canceledAt, canceledByVendor: j.canceledByVendor });
    const shown = { cancelReason: REASON, canceledAt: s.cancelAt, canceledByVendor: false };
    const hidden = { cancelReason: null, canceledAt: null, canceledByVendor: false };
    const seen = async (actor: Actor) => {
      const one = pick(await s.f.run((tx) => getJob(actor, tx, s.job.id)));
      const listed = (await s.f.run((tx) => listJobs(actor, tx, window, 1))).find((j) => j.id === s.job.id)!;
      expect(pick(listed)).toEqual(one);
      return one;
    };
    // Canceled now: everyone who can read it sees why.
    for (const who of [s.a, s.vendor, s.f.coord]) expect(await seen(who)).toEqual(shown);
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    expect(await seen(s.a)).toEqual(hidden);
    expect(await seen(s.vendor)).toEqual(hidden);
    expect(await seen(s.f.coord)).toEqual(shown);
    const admin = (await makeUser(get().db, "admin", "ra14-admin@example.test")).actor;
    expect(await seen(admin)).toEqual(shown);
  });

  test("recommendations never carry the cancel fields of a reactivated detail", async () => {
    const s = await canceledDetail("ra15");
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    const fresh = await s.f.person();
    await s.f.run((tx) => setEarningsGoal(fresh, tx, 1_000_000));
    const recs = await s.f.run((tx) => recommendationsFor(fresh, tx, s.now));
    // Earlier tests reactivated details at the same times, so the pick may be any of them: each was canceled with a reason.
    const reactivated = (await get().db.select({ id: jobs.id, cancelReason: jobs.cancelReason }).from(jobs)).filter((j) => j.cancelReason && recs.some((r) => r.id === j.id));
    expect(reactivated.length).toBeGreaterThan(0);
    for (const rec of recs) expect({ cancelReason: rec.cancelReason, canceledAt: rec.canceledAt, canceledByVendor: rec.canceledByVendor }).toEqual({ cancelReason: null, canceledAt: null, canceledByVendor: false });
    expect(JSON.stringify(recs)).not.toContain(REASON);
  });

  /** A released detail with three deputies, canceled late by the vendor: everyone signed up is owed late-cancel pay. */
  async function lateCanceled(prefix: string) {
    const f = await setupFixture(get().db, prefix);
    const { job, positionId } = await f.mkJob({ count: 3 });
    const people = [await f.person(), await f.person(), await f.person()];
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    for (const d of people) await f.run((tx) => signUp(d, tx, positionId, { warningVersion: 1, now: t0 }));
    const lateAt = new Date(job.startAt.getTime() - 2 * HOUR);
    await f.run((tx) => cancelJob(f.coord, tx, job.id, REASON, { cause: "vendor", now: lateAt }));
    return { f, job, positionId, people, now: new Date(lateAt.getTime() + 10 * 60_000) };
  }

  test("reactivating voids every late-cancel row, with audits; the pay stops counting; those deputies sign up again with no warning", async () => {
    const s = await lateCanceled("ra20");
    const [p, q, r] = s.people;
    const afterEnd = new Date(s.job.endAt.getTime() + HOUR);
    expect((await rows(s.job.id)).map((x) => x.status)).toEqual(["late_canceled", "late_canceled", "late_canceled"]);
    expect((await s.f.run((tx) => loadUnbilled(tx, p.userId, afterEnd))).map((u) => u.jobId)).toEqual([s.job.id]);
    expect((await s.f.run((tx) => jobAdmin(s.f.coord, tx, s.job.id))).lateCanceled).toBe(3);
    const preview = await s.f.run((tx) => reactivationPreview(s.f.coord, tx, s.job.id));
    expect(preview.unbilled.map((u) => u.userId).sort()).toEqual([p.userId, q.userId, r.userId].sort());

    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    const after = await rows(s.job.id);
    expect(after.map((x) => [x.status, x.removalReason])).toEqual(Array(3).fill(["canceled", "detail reactivated"]));
    const audits = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "assignment.late_cancel_void"), inArray(auditLog.entityId, after.map((x) => x.id))));
    expect(audits.map((x) => x.reason)).toEqual(Array(3).fill("detail reactivated"));
    expect(audits.every((x) => (x.before as { status: string }).status === "late_canceled" && x.actorUserId === s.f.coord.userId)).toBe(true);
    // The pay no longer counts anywhere, even after the end.
    expect(await s.f.run((tx) => loadUnbilled(tx, p.userId, afterEnd))).toEqual([]);
    expect((await s.f.run((tx) => jobAdmin(s.f.coord, tx, s.job.id))).lateCanceled).toBe(0);
    // The deputy got the neutral back-on alert, which says nothing about pay.
    const [backOn] = (await alerts(s.job.id, "job.reactivated")).filter((n) => n.userId === p.userId);
    expect(backOn.body).toBe(`Detail #${s.job.number} on ${day(s.job.startAt)} is back on. Sign up again if you still want it.`);
    // Their own list shows the neutral back-on line, not the cancel reason or the void reason.
    const [mine] = await s.f.run((tx) => myDetails(p, tx, s.now));
    expect(mine.reason).toBe("This detail is back on. Sign up again if you still want it.");
    // They sign up again like anyone else.
    for (const d of [p, q, r]) expect((await s.f.run((tx) => signUp(d, tx, s.positionId, { warningVersion: 1, now: s.now }))).status).toBe("signed_up");
  });

  test("a late-cancel invoice already on the detail (billed before the end rule) stops the reactivation", async () => {
    const s = await lateCanceled("ra22");
    const [p] = s.people;
    const [a] = (await rows(s.job.id)).filter((x) => x.userId === p.userId);
    await get().db.update(assignments).set({ status: "billed" }).where(eq(assignments.id, a.id));
    await get().db.insert(invoices).values({ assignmentId: a.id, vendorId: s.f.vendorId, payeeUserId: p.userId, minutes: 240, rateCents: 7000, totalCents: 28000, status: "sent", emailStatus: "sent", kind: "late_cancel" });
    expect(await ruleMessage(s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now)))).toEqual(["Late-cancel pay for this detail was already billed, so it cannot be reactivated"]);
    expect((await get().db.select().from(jobs).where(eq(jobs.id, s.job.id)))[0].state).toBe("canceled");
    expect((await rows(s.job.id)).map((x) => x.status).sort()).toEqual(["billed", "late_canceled", "late_canceled"]);
  });

  test("cancel, reactivate, cancel, reactivate: the history keeps every step in order, and each round tells that cancel's people", async () => {
    const s = await canceledDetail("ra21");
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, WHY, s.now));
    await s.f.run((tx) => signUp(s.a, tx, s.positionId, { warningVersion: 1, now: s.now }));
    await s.f.run((tx) => cancelJob(s.f.coord, tx, s.job.id, "Second cancel", { now: s.now }));
    await s.f.run((tx) => reactivateJob(s.f.coord, tx, s.job.id, "Second reactivation", s.now));
    const events = (await s.f.run((tx) => jobAdmin(s.f.coord, tx, s.job.id))).events.map((e) => [e.kind, e.reason]);
    expect(events).toEqual([
      ["canceled", REASON],
      ["reactivated", WHY],
      ["canceled", "Second cancel"],
      ["reactivated", "Second reactivation"],
    ]);
    const told = await alerts(s.job.id, "job.reactivated");
    const count = (userId: string) => told.filter((n) => n.userId === userId).length;
    expect([count(s.a.userId), count(s.b.userId), count(s.c.userId), count(s.vendor.userId)]).toEqual([2, 1, 1, 2]);
    expect((await s.f.run((tx) => jobActivity(s.a, tx, s.job.id))).filter((r) => /^The detail was/.test(r.text)).map((r) => r.text)).toEqual([
      "The detail was reactivated",
      "The detail was canceled",
      "The detail was reactivated",
      "The detail was canceled",
    ]);
  });
});
