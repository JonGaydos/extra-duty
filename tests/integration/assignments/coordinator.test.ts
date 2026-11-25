import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, spotOffers, notifications, seasons, vendorRestrictions } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assignPerson, liftVendorRestriction, markNoShow, restrictFromVendor } from "@/domain/assignments/coordinator";
import { cancelSignup } from "@/domain/assignments/cancel";
import { joinBackup, signUp } from "@/domain/assignments/signup";
import { ForbiddenError, RuleViolation } from "@/domain/errors";
import { makeUser } from "../users/helpers";
import { HOUR, setupFixture } from "./helpers";

describe("coordinator assignment actions", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  const warn = { warningVersion: 1 };

  beforeAll(async () => {
    f = await setupFixture(get().db, "co");
    admin = (await makeUser(get().db, "admin", "co-admin@example.test")).actor;
  });

  const assign = (p: string, u: string, o: { overrideReason?: string; notify: boolean }, a: Actor = f.coord) =>
    f.run((tx) => assignPerson(a, tx, p, u, o));
  const checks = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(RuleViolation);
    return (e as RuleViolation).checks.filter((c) => !c.ok).map((c) => c.check);
  };

  test("assignPerson over a cap needs an override reason, stores it and audits it", async () => {
    const [season] = await get().db.update(seasons).set({ weekCapMinutes: 60 }).where(eq(seasons.name, "All year")).returning();
    try {
      const { positionId } = await f.mkJob();
      const me = await f.person();
      expect(await checks(assign(positionId, me.userId, { notify: false }))).toEqual(["cap_week"]);
      const row = await assign(positionId, me.userId, { overrideReason: "Staffing shortage", notify: true });
      expect(row).toMatchObject({ status: "signed_up", overrideReason: "Staffing shortage" });
      const log = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, row.id), eq(auditLog.action, "assignment.assign")));
      expect(log[0].reason).toBe("Staffing shortage");
      const mail = await get().db.select().from(notifications).where(eq(notifications.userId, me.userId));
      expect(mail.map((n) => n.type)).toContain("assignment.assigned");
    } finally {
      await get().db.update(seasons).set({ weekCapMinutes: null }).where(eq(seasons.id, season.id));
    }
  });

  test("assignPerson ending an offer tells the offered backup", async () => {
    const { job, positionId } = await f.mkJob();
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const holder = await f.person();
    const b1 = await f.person();
    const a = await f.run((tx) => signUp(holder, tx, positionId, { ...warn, now: t0 }));
    await f.run((tx) => joinBackup(b1, tx, positionId, { ...warn, now: t0 }));
    await f.run((tx) => cancelSignup(holder, tx, a.id, "Plans changed", new Date(job.startAt.getTime() - 48 * HOUR)));
    const target = await f.person();
    await assign(positionId, target.userId, { notify: false });
    const [offer] = await get().db.select().from(spotOffers).where(eq(spotOffers.jobPositionId, positionId));
    expect(offer.status).toBe("expired");
    const mail = await get().db.select().from(notifications).where(and(eq(notifications.userId, b1.userId), eq(notifications.type, "spot.offer_ended")));
    expect(mail).toHaveLength(1);
  });

  test("a full position can be over-assigned with a reason", async () => {
    const { job, positionId } = await f.mkJob();
    const holder = await f.person();
    await f.run((tx) => signUp(holder, tx, positionId, { ...warn, now: new Date(job.startAt.getTime() - 48 * HOUR) }));
    const extra = await f.person();
    expect(await checks(assign(positionId, extra.userId, { notify: false }))).toEqual(["state"]);
    expect((await assign(positionId, extra.userId, { overrideReason: "Extra body needed", notify: false })).status).toBe("signed_up");
  });

  test("personnel and vendors cannot assign, no-show or restrict", async () => {
    const { positionId } = await f.mkJob();
    const me = await f.person();
    const { actor } = await makeUser(get().db, "vendor", "co-vendor@example.test");
    const vendor = { ...actor, vendorId: f.vendorId };
    for (const a of [me, vendor]) {
      await expect(assign(positionId, me.userId, { notify: false }, a)).rejects.toBeInstanceOf(ForbiddenError);
      await expect(f.run((tx) => restrictFromVendor(a, tx, me.userId, f.vendorId, { reason: "x", removeFromFutureDetails: false }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(f.run((tx) => liftVendorRestriction(a, tx, "nope"))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(f.run((tx) => markNoShow(a, tx, "nope", "x"))).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  test("markNoShow sets no_show, audits the note and opens no spot", async () => {
    const { job, positionId } = await f.mkJob();
    const me = await f.person();
    const a = await f.run((tx) => signUp(me, tx, positionId, { ...warn, now: new Date(job.startAt.getTime() - 48 * HOUR) }));
    const after = await f.run((tx) => markNoShow(admin, tx, a.id, "Did not arrive", new Date(job.startAt.getTime() + HOUR)));
    expect(after.status).toBe("no_show");
    const log = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, a.id), eq(auditLog.action, "assignment.no_show")));
    expect(log[0].reason).toBe("Did not arrive");
    const [{ n }] = (await get().db.execute(`select count(*)::int as n from spot_offers where job_position_id = '${positionId}'`)).rows as { n: number }[];
    expect(n).toBe(0);
  });

  test("a restricted deputy cannot sign up, join as backup or be assigned (even with an override); other vendors are unaffected", async () => {
    const mine = await f.mkJob();
    const other = await f.mkJob({ vendor: f.otherVendorId });
    const me = await f.person();
    const holder = await f.person();
    const t = new Date(mine.job.startAt.getTime() - 48 * HOUR);
    await f.run((tx) => signUp(holder, tx, mine.positionId, { ...warn, now: t }));
    await f.run((tx) => restrictFromVendor(f.coord, tx, me.userId, f.vendorId, { reason: "Conduct", removeFromFutureDetails: false }));
    expect(await checks(f.run((tx) => signUp(me, tx, mine.positionId, { ...warn, now: t })))).toContain("vendor_restricted");
    expect(await checks(f.run((tx) => joinBackup(me, tx, mine.positionId, { ...warn, now: t })))).toContain("vendor_restricted");
    const refused = assign(mine.positionId, me.userId, { overrideReason: "Please", notify: false });
    expect(await checks(refused)).toContain("vendor_restricted");
    expect((await f.run((tx) => signUp(me, tx, other.positionId, { ...warn, now: t }))).status).toBe("signed_up");
  });

  test("restrictFromVendor can remove future sign-ups for that vendor only, and lifting restores access", async () => {
    const a = await f.mkJob();
    const b = await f.mkJob({ vendor: f.otherVendorId });
    const me = await f.person();
    const sa = await f.run((tx) => signUp(me, tx, a.positionId, { ...warn, now: new Date(a.job.startAt.getTime() - 48 * HOUR) }));
    const sb = await f.run((tx) => signUp(me, tx, b.positionId, { ...warn, now: new Date(b.job.startAt.getTime() - 48 * HOUR) }));
    const r = await f.run((tx) =>
      restrictFromVendor(f.coord, tx, me.userId, f.vendorId, { reason: "Conduct", removeFromFutureDetails: true, now: new Date(a.job.startAt.getTime() - 24 * HOUR) }),
    );
    const status = async (id: string) => (await get().db.select().from(assignments).where(eq(assignments.id, id)))[0];
    expect(await status(sa.id)).toMatchObject({ status: "removed", removalReason: "Restricted: Conduct" });
    expect((await status(sb.id)).status).toBe("signed_up");
    await f.run((tx) => liftVendorRestriction(admin, tx, r.id, "Resolved"));
    const [lifted] = await get().db.select().from(vendorRestrictions).where(eq(vendorRestrictions.id, r.id));
    expect(lifted.liftedAt).not.toBeNull();
    const again = await f.mkJob();
    expect((await f.run((tx) => signUp(me, tx, again.positionId, { ...warn, now: new Date(again.job.startAt.getTime() - 48 * HOUR) }))).status).toBe("signed_up");
  });
});
