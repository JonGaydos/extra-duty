import { afterEach, beforeAll, describe, expect, test } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, jobs, notifications, spotGiveaways, spotOffers, users, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { claimSpot } from "@/domain/assignments/backups";
import { cancelSignup } from "@/domain/assignments/cancel";
import { removePerson } from "@/domain/assignments/coordinator";
import { assignReplacement, cancelOffer, giveawayRemindersTick, offerSpot, withdrawOffer } from "@/domain/assignments/giveaway";
import { eligibilityByPosition, joinBackup, signUp } from "@/domain/assignments/signup";
import { coordinatorTodo, jobAdmin } from "@/domain/coordinator/views";
import { RuleViolation, ValidationError } from "@/domain/errors";
import { setConfidential } from "@/domain/jobs/confidential";
import { linkableDetails } from "@/domain/messages/messages";
import { jobRoster, loadJobCards, myDetails, upNextAndBackup } from "@/domain/personnel/views";
import { updateSettings } from "@/domain/settings/settings";
import { HOUR, MIN, setupFixture } from "./helpers";
import { makeUser } from "../users/helpers";

describe("giving a spot away keeps the deputy responsible until someone takes it", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  const warn = { warningVersion: 1 };

  beforeAll(async () => {
    f = await setupFixture(get().db, "gv");
    await get().db.update(users).set({ name: "Dana Coord" }).where(eq(users.id, f.coord.userId));
  });
  afterEach(async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { backupOfferMode: "sequential", backupWindowMinutes: 30, vendorSeesAssignedNames: true }));
  });

  const named = async (name: string, rank = "Deputy Sheriff") => {
    const a = await f.person(rank);
    await get().db.update(users).set({ name }).where(eq(users.id, a.userId));
    return a;
  };
  const sign = (a: Actor, positionId: string, now: Date) => f.run((tx) => signUp(a, tx, positionId, { ...warn, now }));
  const offer = (a: Actor, id: string, now: Date, why = "Family event") => f.run((tx) => offerSpot(a, tx, id, why, now));
  const row = async (id: string) => (await get().db.select().from(assignments).where(eq(assignments.id, id)))[0];
  const giveaway = async (assignmentId: string) => (await get().db.select().from(spotGiveaways).where(eq(spotGiveaways.assignmentId, assignmentId)).orderBy(asc(spotGiveaways.createdAt)))[0];
  const inbox = async (userId: string, type: string) =>
    (await get().db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)))).map((n) => n.body);
  const failing = async (p: Promise<unknown>) => {
    const e = await p.then(() => null, (err: unknown) => err);
    expect(e).toBeInstanceOf(RuleViolation);
    return (e as RuleViolation).checks.filter((c) => !c.ok).map((c) => c.message);
  };

  /** One filled spot held by Carmen, two days before the start. */
  async function held(o: { backups?: number } = {}) {
    const { job, positionId } = await f.mkJob();
    const t0 = new Date(job.startAt.getTime() - 72 * HOUR);
    const carmen = await named("Carmen Caldwell");
    const mine = await sign(carmen, positionId, t0);
    const backups: Array<{ actor: Actor; id: string }> = [];
    for (let i = 0; i < (o.backups ?? 0); i++) {
      const b = await f.person();
      backups.push({ actor: b, id: (await f.run((tx) => joinBackup(b, tx, positionId, { ...warn, now: t0 }))).id });
    }
    return { job, positionId, carmen, mine, backups, at: new Date(job.startAt.getTime() - 48 * HOUR) };
  }

  test("an offer keeps the deputy assigned: still signed up, on Up next and the roster as Offered", async () => {
    const s = await held();
    await offer(s.carmen, s.mine.id, s.at);
    expect((await row(s.mine.id)).status).toBe("signed_up");
    expect(await giveaway(s.mine.id)).toMatchObject({ status: "open", reason: "Family event" });
    const mine = await f.run((tx) => myDetails(s.carmen, tx, s.at));
    const { upNext } = upNextAndBackup(mine, s.at);
    expect(upNext.map((d) => [d.job.id, d.label])).toEqual([[s.job.id, "Offered"]]);
    const roster = await f.run((tx) => jobRoster(s.carmen, tx, s.job.id));
    expect(roster.map((r) => [r.name, r.label, r.offered])).toEqual([["Carmen Caldwell", "Offered", true]]);
    // Others see the spot as open.
    const other = await f.person();
    const [card] = await f.run(async (tx) => loadJobCards(other, tx, [(await tx.select().from(jobs).where(eq(jobs.id, s.job.id)))[0]], s.at));
    expect(card).toMatchObject({ availability: "open", openSpots: 1, offered: false });
    // The offered spot still counts as assigned for messages about the detail.
    expect((await f.run((tx) => linkableDetails(s.carmen, tx, s.at))).map((d) => d.id)).toContain(s.job.id);
  });

  test("cancel no longer removes a signed-up deputy, and an offer needs a reason", async () => {
    const s = await held();
    const e = await f.run((tx) => cancelSignup(s.carmen, tx, s.mine.id, "Sick", s.at)).then(() => null, (x: unknown) => x);
    expect(e).toBeInstanceOf(ValidationError);
    expect((await row(s.mine.id)).status).toBe("signed_up");
    await expect(offer(s.carmen, s.mine.id, s.at, "  ")).rejects.toThrow("A reason is required.");
    const other = await f.person();
    await expect(f.run((tx) => offerSpot(other, tx, s.mine.id, "Not mine", s.at))).rejects.toThrow();
  });

  test("takeover replaces the deputy: given away, the new person assigned, both told, the vendor too", async () => {
    const s = await held();
    const [vendorLogin] = [await makeUser(get().db, "vendor", "gv-vendor@example.test")];
    await get().db.insert(vendorUsers).values({ vendorId: f.vendorId, userId: vendorLogin.row.id });
    await offer(s.carmen, s.mine.id, s.at);
    const jordan = await named("Jordan Example");
    const took = await sign(jordan, s.positionId, new Date(s.at.getTime() + HOUR));
    expect(took.status).toBe("signed_up");
    expect(await row(s.mine.id)).toMatchObject({ status: "canceled", removalReason: "Taken over by Jordan Example" });
    expect(await giveaway(s.mine.id)).toMatchObject({ status: "taken", takenByAssignmentId: took.id });
    expect(await inbox(s.carmen.userId, "giveaway.taken_over")).toEqual(["Jordan Example took over your spot. You are no longer on this detail."]);
    expect((await inbox(jordan.userId, "giveaway.taken_over"))[0]).toContain("You replace Carmen Caldwell");
    expect((await inbox(vendorLogin.row.id, "giveaway.taken_over"))[0]).toContain("Jordan Example replaces Carmen Caldwell");
    // Carmen's calendar and caps free up: the detail leaves her Up next.
    const { upNext } = upNextAndBackup(await f.run((tx) => myDetails(s.carmen, tx, s.at)), s.at);
    expect(upNext).toHaveLength(0);
    const audit = await get().db.select().from(auditLog).where(and(eq(auditLog.entityId, s.mine.id), eq(auditLog.action, "assignment.taken_over")));
    expect(audit).toHaveLength(1);
  });

  test("the vendor is not told names when vendors do not see who is assigned", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { vendorSeesAssignedNames: false }));
    const s = await held();
    const login = await makeUser(get().db, "vendor", "gv-vendor2@example.test");
    await get().db.insert(vendorUsers).values({ vendorId: f.vendorId, userId: login.row.id });
    await offer(s.carmen, s.mine.id, s.at);
    await sign(await f.person(), s.positionId, s.at);
    expect(await inbox(login.row.id, "giveaway.taken_over")).toEqual([]);
  });

  test("a backup's turn comes first, then the backup who claims replaces the deputy", async () => {
    const s = await held({ backups: 1 });
    await offer(s.carmen, s.mine.id, s.at);
    const [o] = await get().db.select().from(spotOffers).where(eq(spotOffers.jobPositionId, s.positionId));
    expect(o).toMatchObject({ status: "open", offeredToAssignmentId: s.backups[0].id });
    const outsider = await f.person();
    expect(await failing(sign(outsider, s.positionId, s.at))).toEqual(["Backups have first chance at this spot"]);
    const won = await f.run((tx) => claimSpot(s.backups[0].actor, tx, s.positionId, { ...warn, now: new Date(s.at.getTime() + 5 * MIN) }));
    expect(won.status).toBe("signed_up");
    expect((await row(s.mine.id)).status).toBe("canceled");
    expect((await giveaway(s.mine.id)).takenByAssignmentId).toBe(s.backups[0].id);
  });

  test("an ineligible person cannot take over, and the deputy keeps the spot", async () => {
    const s = await held();
    await offer(s.carmen, s.mine.id, s.at);
    const posse = await f.person("Posse");
    const problems = await failing(sign(posse, s.positionId, s.at));
    expect(problems.length).toBeGreaterThan(0);
    expect((await row(s.mine.id)).status).toBe("signed_up");
    expect((await giveaway(s.mine.id)).status).toBe("open");
  });

  test("withdrawing keeps the spot: the position is full again and backup offers end", async () => {
    const s = await held({ backups: 1 });
    await offer(s.carmen, s.mine.id, s.at);
    await f.run((tx) => withdrawOffer(s.carmen, tx, s.mine.id, new Date(s.at.getTime() + MIN)));
    expect((await giveaway(s.mine.id)).status).toBe("withdrawn");
    expect((await get().db.select().from(spotOffers).where(eq(spotOffers.jobPositionId, s.positionId))).map((o) => o.status)).toEqual(["expired"]);
    expect(await inbox(s.backups[0].actor.userId, "spot.offer_ended")).toHaveLength(1);
    expect(await failing(sign(await f.person(), s.positionId, s.at))).toEqual(["This position is full"]);
    await expect(f.run((tx) => withdrawOffer(s.carmen, tx, s.mine.id, s.at))).rejects.toThrow("There is no open offer on this sign-up.");
    // The deputy can offer again later.
    await offer(s.carmen, s.mine.id, new Date(s.at.getTime() + HOUR));
  });

  test("a confidential spot cannot be given away, and an offer cannot be made once the detail started", async () => {
    const s = await held();
    await f.run((tx) => setConfidential(f.coord, tx, s.job.id, true, "Dignitary visit"));
    await expect(offer(s.carmen, s.mine.id, s.at)).rejects.toThrow("A confidential detail is never offered to others.");
    const t = await held();
    await expect(offer(t.carmen, t.mine.id, new Date(t.job.startAt.getTime() + MIN))).rejects.toThrow("This detail has started.");
  });

  test("turning a detail confidential cancels its open offers", async () => {
    const s = await held();
    await offer(s.carmen, s.mine.id, s.at);
    await f.run((tx) => setConfidential(f.coord, tx, s.job.id, true, "Dignitary visit"));
    expect((await giveaway(s.mine.id)).status).toBe("canceled");
    expect((await row(s.mine.id)).status).toBe("signed_up");
  });

  test("coordinator remove still works on an offered spot, and the offer ends with it", async () => {
    const s = await held({ backups: 1 });
    await offer(s.carmen, s.mine.id, s.at);
    await f.run((tx) => removePerson(f.coord, tx, s.mine.id, "Out of uniform", s.at));
    expect(await row(s.mine.id)).toMatchObject({ status: "removed", removalReason: "Out of uniform" });
    expect((await giveaway(s.mine.id)).status).toBe("ended");
    // The spot was already being offered: no second offer to the backup.
    expect(await get().db.select().from(spotOffers).where(eq(spotOffers.jobPositionId, s.positionId))).toHaveLength(1);
    const admin = await f.run((tx) => jobAdmin(f.coord, tx, s.job.id));
    expect(admin.roster[0]).toMatchObject({ label: "Removed by coordinator", offeredAt: null });
    expect(admin.roster[0].offerLines.map((l) => l.text)).toEqual([expect.stringMatching(/^Offered by Carmen Caldwell on \w{3} \d+: Family event$/), "Offer ended"]);
  });

  test("staff cancel the offer or assign a replacement directly, both audited", async () => {
    const s = await held();
    await offer(s.carmen, s.mine.id, s.at);
    await f.run((tx) => cancelOffer(f.coord, tx, s.mine.id, s.at));
    expect((await giveaway(s.mine.id)).status).toBe("canceled");
    expect(await inbox(s.carmen.userId, "giveaway.canceled")).toHaveLength(1);
    await offer(s.carmen, s.mine.id, s.at, "Court date");
    const jordan = await named("Jordan Example");
    const replaced = await f.run((tx) => assignReplacement(f.coord, tx, s.mine.id, jordan.userId, { now: s.at }));
    expect(replaced.status).toBe("signed_up");
    expect((await row(s.mine.id)).status).toBe("canceled");
    const admin = await f.run((tx) => jobAdmin(f.coord, tx, s.job.id));
    const carmenRow = admin.roster.find((r) => r.assignmentId === s.mine.id)!;
    expect(carmenRow.label).toBe("Gave away");
    expect(carmenRow.offerLines.map((l) => l.text)).toEqual([
      expect.stringContaining("Offered by Carmen Caldwell on"),
      "Offer canceled by Dana Coord",
      expect.stringContaining(": Court date"),
      "Taken over by Jordan Example",
    ]);
    const actions = (await get().db.select().from(auditLog).where(eq(auditLog.entityId, s.mine.id))).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(["assignment.offer", "assignment.offer_cancel", "assignment.taken_over"]));
  });

  test("an offered spot nobody took is on To-do inside the late window, and the deputy is reminded once", async () => {
    const s = await held();
    await offer(s.carmen, s.mine.id, s.at);
    const early = await f.run((tx) => coordinatorTodo(f.coord, tx, s.at));
    expect(early.offeredNotTaken.find((r) => r.assignmentId === s.mine.id)).toBeUndefined();
    const late = new Date(s.job.startAt.getTime() - 23 * HOUR);
    const todo = await f.run((tx) => coordinatorTodo(f.coord, tx, late));
    expect(todo.offeredNotTaken.find((r) => r.assignmentId === s.mine.id)).toMatchObject({ name: "Carmen Caldwell", number: s.job.number });
    await f.run((tx) => giveawayRemindersTick(late, tx));
    await f.run((tx) => giveawayRemindersTick(new Date(late.getTime() + MIN), tx));
    expect(await inbox(s.carmen.userId, "giveaway.reminder")).toHaveLength(1);
    // Nothing is removed automatically; at the start the offer ends and the deputy works it.
    await f.run((tx) => giveawayRemindersTick(new Date(s.job.startAt.getTime() + MIN), tx));
    expect((await row(s.mine.id)).status).toBe("signed_up");
    expect((await giveaway(s.mine.id)).status).toBe("ended");
  });

  test("a takeover eligibility check reads the offered spot as open for others", async () => {
    const s = await held();
    await offer(s.carmen, s.mine.id, s.at);
    const other = await f.person();
    const [e] = await f.run((tx) => eligibilityByPosition(other, tx, s.job.id, s.at));
    expect(e.canSignUp).toBe(true);
  });
});
