import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, invoices, jobs, qualifications, userQualifications, users } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { offerSpot } from "@/domain/assignments/giveaway";
import { signUp } from "@/domain/assignments/signup";
import { markNoShow, removePerson } from "@/domain/assignments/coordinator";
import { ForbiddenError } from "@/domain/errors";
import { cancelJob } from "@/domain/jobs/jobs";
import { exportReport, runReport, type ReportSpec } from "@/domain/reports/engine";
import { listSavedReports, saveReport } from "@/domain/reports/saved";
import { agencyInstant } from "@/domain/time/agency-time";
import { HOUR, legacyCancel, setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";

const FROM = agencyInstant(2035, 1, 1, 0, 0);
const TO = agencyInstant(2035, 12, 31, 23, 59);
const MEASURES = ["details_worked", "hours", "earned_cents", "signups", "gave_away", "late_cancels", "removals", "no_shows", "cancellations", "cancellation_rate"] as const;
const spec = (o: Partial<ReportSpec> = {}): ReportSpec => ({ dataset: "activity", from: FROM, to: TO, filters: {}, groupBy: ["deputy"], measures: [...MEASURES], ...o });

describe("personnel activity report", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let a: Actor;
  let b: Actor;
  let c: Actor;
  let qualId: string;

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "act");
    a = await fx.person("Deputy Sheriff");
    b = await fx.person("CSO");
    c = await fx.person("Deputy Sheriff");
    await db.update(users).set({ name: "Avery Act" }).where(eq(users.id, a.userId));
    await db.update(users).set({ name: "Blake Act" }).where(eq(users.id, b.userId));
    await db.update(users).set({ name: "Casey Act" }).where(eq(users.id, c.userId));
    qualId = (await db.select().from(qualifications).limit(1))[0].id;
    await db.insert(userQualifications).values({ userId: a.userId, qualificationId: qualId });

    const row = async (who: Actor, status: (typeof assignments.$inferInsert)["status"], count = 1) => {
      const { job, positionId } = await fx.mkJob({ count });
      const [asg] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: who.userId, status }).returning();
      return { job, positionId, asg };
    };
    const billed = async (who: Actor, minutes: number, status: "sent" | "paid", kind: "detail" | "late_cancel" = "detail") => {
      const { job, asg } = await row(who, status === "paid" ? "paid" : "billed");
      await db.update(assignments).set({ actualStartAt: job.startAt, actualEndAt: new Date(job.startAt.getTime() + minutes * 60_000) }).where(eq(assignments.id, asg.id));
      await db.insert(invoices).values({ assignmentId: asg.id, vendorId: fx.vendorId, payeeUserId: who.userId, minutes, rateCents: 7000, totalCents: Math.round((minutes * 7000) / 60), status, kind });
    };

    // Avery: two worked (4 h sent, 2 h paid), one paid late cancellation, one gave away and signed up again,
    // one removed, one no-show, one released by a detail cancellation (the agency's, not counted against them).
    await billed(a, 240, "sent");
    await billed(a, 120, "paid");
    await billed(a, 240, "sent", "late_cancel");
    // Avery's was canceled before giving away replaced canceling: it stays canceled and counts as Gave away.
    const gave = await row(a, "signed_up", 2);
    await legacyCancel(db, a, gave.asg.id, "Family event");
    await db.insert(assignments).values({ jobId: gave.job.id, jobPositionId: gave.positionId, userId: a.userId, status: "signed_up" });
    const removed = await row(a, "signed_up");
    await fx.run((tx) => removePerson(fx.coord, tx, removed.asg.id, "Out of uniform"));
    const noShow = await row(a, "signed_up");
    await fx.run((tx) => markNoShow(fx.coord, tx, noShow.asg.id, "Did not arrive", new Date(noShow.job.startAt.getTime() + 3_600_000)));
    const canceledJob = await row(a, "signed_up");
    await fx.run((tx) => cancelJob(fx.coord, tx, canceledJob.job.id, "Event called off"));

    // Blake: one worked hour, one given away (offered, then taken over by Drew), one late cancellation not billed yet.
    await billed(b, 60, "sent");
    const bGave = await row(b, "signed_up");
    const t0 = new Date(bGave.job.startAt.getTime() - 48 * HOUR);
    await fx.run((tx) => offerSpot(b, tx, bGave.asg.id, "Sick", t0));
    const drew = await fx.person("Deputy Sheriff");
    await db.update(users).set({ name: "Drew Act" }).where(eq(users.id, drew.userId));
    await fx.run((tx) => signUp(drew, tx, bGave.positionId, { warningVersion: 1, now: t0 }));
    await row(b, "late_canceled");

    // Outside the period: never counted.
    const old = await row(a, "no_show");
    await db.update(jobs).set({ startAt: agencyInstant(2034, 6, 1, 17, 0), endAt: agencyInstant(2034, 6, 1, 21, 0) }).where(eq(jobs.id, old.job.id));
  });

  const byName = (r: Awaited<ReturnType<typeof runReport>>) => Object.fromEntries(r.rows.map((row) => [row[0] as string, row.slice(1)]));

  test("one row per person with worked, earnings, sign-ups and each kind of cancellation", async () => {
    const r = await fx.run((tx) => runReport(fx.coord, tx, spec()));
    expect(r.columns).toEqual(["deputy", ...MEASURES]);
    const rows = byName(r);
    // details, hours, earnings, sign-ups, gave away, vendor late cancel, removed, no-show, cancellations, rate (percent).
    // A vendor's late cancel is shown but never counts against the person: not in the total, not in the rate.
    expect(rows["Avery Act"]).toEqual([2, 6, 70000, 8, 1, 1, 1, 1, 3, 37.5]);
    expect(rows["Blake Act"]).toEqual([1, 1, 7000, 3, 1, 1, 0, 0, 1, 33.3]);
    // Active sworn personnel with nothing in the period still get a row.
    expect(rows["Casey Act"]).toEqual([0, 0, 0, 0, 0, 0, 0, 0, 0, null]);
    // Drew took over Blake's offered spot: one open sign-up.
    expect(rows["Drew Act"]).toEqual([0, 0, 0, 1, 0, 0, 0, 0, 0, 0]);
    expect(r.totals).toMatchObject({ details_worked: 3, earned_cents: 77000, signups: 12, late_cancels: 2, cancellations: 4 });
    expect(r.totals.cancellation_rate).toBeCloseTo(33.3, 1);
  });

  test("each row carries the person's id so the page can link to the deputy report", async () => {
    const r = await fx.run((tx) => runReport(fx.coord, tx, spec()));
    const i = r.rows.findIndex((row) => row[0] === "Avery Act");
    expect(r.keys[i]).toEqual([a.userId]);
  });

  test("rank and flag filters", async () => {
    const cso = await fx.run((tx) => runReport(fx.coord, tx, spec({ filters: { rankIds: [fx.rank["CSO"]] } })));
    expect(cso.rows.map((row) => row[0])).toEqual(["Blake Act"]);
    const flagged = await fx.run((tx) => runReport(fx.coord, tx, spec({ filters: { qualificationIds: [qualId] } })));
    expect(flagged.rows.map((row) => row[0])).toEqual(["Avery Act"]);
  });

  test("vendors never appear and only coordinators and admins may run it", async () => {
    const { actor: vendorUser } = await makeUser(get().db, "vendor", "act-vendor@example.test");
    const r = await fx.run((tx) => runReport(fx.coord, tx, spec()));
    expect(r.rows.some((row) => row[0] === "act-vendor")).toBe(false);
    await expect(fx.run((tx) => runReport(a, tx, spec()))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(fx.run((tx) => runReport({ ...vendorUser, vendorId: fx.vendorId }, tx, spec()))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("CSV export and saved reports use the same engine", async () => {
    const csv = (await fx.run((tx) => exportReport(fx.coord, tx, spec(), "csv"))).toString("utf8");
    const [header, ...lines] = csv.trim().split(/\r?\n/);
    expect(header).toBe("Person,Details worked,Hours worked,Earnings ($),Sign-ups,Gave away,Vendor late cancel,Removed by coordinator,No-shows,Cancellations,Cancellation rate (%)");
    expect(lines).toContain("Avery Act,2,6,700.00,8,1,1,1,1,3,37.5");
    const saved = await fx.run((tx) => saveReport(fx.coord, tx, "Activity this year", { ...spec(), from: undefined, to: undefined }));
    const mine = await fx.run((tx) => listSavedReports(fx.coord, tx));
    expect(mine.find((s) => s.id === saved.id)?.spec).toMatchObject({ dataset: "activity", groupBy: ["deputy"] });
  });
});
