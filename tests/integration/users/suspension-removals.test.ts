import { beforeAll, describe, expect, test } from "vitest";
import { eq, inArray } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { assignments, auditLog, notifications, users, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { cancelSignup } from "@/domain/assignments/cancel";
import { removePerson } from "@/domain/assignments/coordinator";
import { SUSPENSION_REMOVE_ACTION } from "@/domain/assignments/history";
import { jobAdmin } from "@/domain/coordinator/views";
import { jobActivity, myDetails } from "@/domain/personnel/views";
import { NO_FILTERS, detailCards } from "@/domain/calendar/calendar";
import { exportReport, runReport, type ReportSpec } from "@/domain/reports/engine";
import { DATASETS } from "@/domain/reports/datasets";
import { ACTIVITY_MEASURES } from "@/domain/reports/saved";
import { suspendUser } from "@/domain/users/suspension";
import { vendorDetails } from "@/domain/vendor-portal/views";
import { agencyInstant } from "@/domain/time/agency-time";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "./helpers";

const FROM = agencyInstant(2035, 1, 1, 0, 0);
const TO = agencyInstant(2035, 12, 31, 23, 59);

describe("removals caused by a suspension", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let vendor: Actor;
  let sam: Actor;
  let lee: Actor;
  let jobId: string;
  let samRow: string;
  let legacyJobId: string;

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "susp");
    admin = (await makeUser(db, "admin", "susp-admin@example.test")).actor;
    const v = await makeUser(db, "vendor", "susp-vendor@example.test");
    await db.insert(vendorUsers).values({ userId: v.row.id, vendorId: f.vendorId });
    vendor = { ...v.actor, vendorId: f.vendorId };
    sam = await f.person();
    lee = await f.person();
    await db.update(users).set({ name: "Sam Susp" }).where(eq(users.id, sam.userId));
    await db.update(users).set({ name: "Lee Susp" }).where(eq(users.id, lee.userId));

    // Sam: signed up on a detail, then suspended with future details removed. Lee: removed by a coordinator.
    const { job, positionId } = await f.mkJob({ count: 2 });
    jobId = job.id;
    samRow = (await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: sam.userId, status: "signed_up" }).returning())[0].id;
    const leeRow = (await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: lee.userId, status: "signed_up" }).returning())[0].id;
    await f.run((tx) => removePerson(f.coord, tx, leeRow, "Out of uniform"));
    // Lee also gives a sign-up away, so the cancellation total has something real in it.
    const other = await f.mkJob();
    const leeGave = (await db.insert(assignments).values({ jobId: other.job.id, jobPositionId: other.positionId, userId: lee.userId, status: "signed_up" }).returning())[0].id;
    await f.run((tx) => cancelSignup(lee, tx, leeGave, "Family event"));

    // A removal written before suspension removals had their own audit action: assignment.remove with the
    // suspension's reason marker, the way Task 9 wrote it.
    const legacy = await f.mkJob();
    legacyJobId = legacy.job.id;
    const [old] = await db.insert(assignments).values({ jobId: legacy.job.id, jobPositionId: legacy.positionId, userId: lee.userId, status: "removed", removalReason: "Suspended" }).returning();
    await db.insert(auditLog).values({ actorUserId: f.coord.userId, action: "assignment.remove", entityType: "assignment", entityId: old.id, before: null, after: old, reason: "Suspended: Policy review" });

    await f.run((tx) => suspendUser(f.coord, tx, sam.userId, { reason: "Pending policy review", until: null, removeFutureAssignments: true }));
  });

  test("the removal is audited with its own action, not as a coordinator removal", async () => {
    const rows = await get().db.select().from(auditLog).where(eq(auditLog.entityId, samRow));
    expect(rows.map((r) => r.action)).toContain(SUSPENSION_REMOVE_ACTION);
    expect(rows.map((r) => r.action)).not.toContain("assignment.remove");
  });

  test("coordinators and admins see Removed by suspension in the sign-up history; a coordinator removal is unchanged", async () => {
    for (const who of [f.coord, admin]) {
      const detail = await f.run((tx) => jobAdmin(who, tx, jobId));
      expect(detail.roster.map((r) => [r.name, r.label])).toEqual([
        ["Sam Susp", "Removed by suspension"],
        ["Lee Susp", "Removed by coordinator"],
      ]);
    }
  });

  test("an older removal that carries the suspension's marker is labeled too", async () => {
    const detail = await f.run((tx) => jobAdmin(f.coord, tx, legacyJobId));
    expect(detail.roster.map((r) => r.label)).toEqual(["Removed by suspension"]);
  });

  test("the suspended deputy's own list says Canceled, with nothing about the suspension", async () => {
    const mine = await f.run((tx) => myDetails(sam, tx, new Date()));
    const row = mine.find((d) => d.assignmentId === samRow)!;
    expect(row).toMatchObject({ status: "canceled", label: "Canceled", reason: "Your sign-up was canceled." });
    expect(JSON.stringify(mine)).not.toMatch(/suspen/i);
    // The older marked row reads the same way for its deputy.
    const lees = await f.run((tx) => myDetails(lee, tx, new Date()));
    expect(lees.find((d) => d.job.id === legacyJobId)).toMatchObject({ status: "canceled", label: "Canceled", reason: "Your sign-up was canceled." });
    // The Details list with My details on keeps it as a gone row, like any other cancellation.
    const { gone } = await f.run((tx) => detailCards(sam, tx, { from: FROM, to: TO }, { ...NO_FILTERS, mine: true }, new Date()));
    expect(gone.map((d) => [d.assignmentId, d.label, d.reason])).toEqual([[samRow, "Canceled", "Your sign-up was canceled."]]);
  });

  test("the detail's activity shows deputies a plain cancellation", async () => {
    const forLee = await f.run((tx) => jobActivity(lee, tx, jobId));
    expect(forLee.map((r) => r.text)).toContain("Sam Susp had a sign-up canceled");
    const forSam = await f.run((tx) => jobActivity(sam, tx, jobId));
    expect(forSam.map((r) => r.text)).toContain("You had a sign-up canceled");
    expect(JSON.stringify([forLee, forSam])).not.toMatch(/suspen/i);
  });

  test("the vendor only sees the name leave the roster", async () => {
    const rows = await f.run((tx) => vendorDetails(vendor, tx, { from: FROM, to: TO }));
    expect(rows.find((r) => r.id === jobId)).toMatchObject({ filled: 0 });
    expect(JSON.stringify(rows)).not.toMatch(/suspen/i);
  });

  test("no alert, email or push to the deputy about the removal, or to the vendor, mentions the suspension", async () => {
    const { db } = get();
    const removal = await db.select().from(notifications).where(eq(notifications.userId, sam.userId));
    const aboutRemoval = removal.filter((n) => n.type !== "user.suspended");
    expect(aboutRemoval.length).toBeGreaterThan(0);
    for (const n of aboutRemoval) expect(`${n.title} ${n.body}`).not.toMatch(/suspen/i);
    const toVendor = await db.select().from(notifications).where(inArray(notifications.userId, [vendor.userId]));
    for (const n of toVendor) expect(`${n.title} ${n.body}`).not.toMatch(/suspen/i);
  });

  const spec = (): ReportSpec => ({ dataset: "activity", from: FROM, to: TO, filters: { userIds: [sam.userId, lee.userId] }, groupBy: ["deputy"], measures: [...ACTIVITY_MEASURES] });

  test("the activity report counts it in its own column and leaves it out of cancellations and the rate", async () => {
    expect(ACTIVITY_MEASURES).toContain("suspension_removals");
    expect(DATASETS.activity.measures).toContain("suspension_removals");
    const r = await f.run((tx) => runReport(f.coord, tx, spec()));
    const rows = Object.fromEntries(r.rows.map((row) => [row[0] as string, Object.fromEntries(r.columns.slice(1).map((c, i) => [c, row[i + 1]]))]));
    expect(rows["Sam Susp"]).toMatchObject({ signups: 1, removals: 0, suspension_removals: 1, cancellations: 0, cancellation_rate: 0 });
    // Lee: removed by a coordinator, gave one away, and the older suspension removal.
    expect(rows["Lee Susp"]).toMatchObject({ signups: 3, removals: 1, suspension_removals: 1, gave_away: 1, cancellations: 2, cancellation_rate: 66.7 });
    expect(r.totals).toMatchObject({ suspension_removals: 2, removals: 1, cancellations: 2 });
  });

  test("the CSV has a Removed by suspension column", async () => {
    const csv = (await f.run((tx) => exportReport(f.coord, tx, spec(), "csv"))).toString("utf8");
    const [header] = csv.trim().split(/\r?\n/);
    expect(header).toBe("Person,Details worked,Hours worked,Earnings ($),Sign-ups,Gave away,Vendor late cancel,Removed by coordinator,Removed by suspension,Left the agency,No-shows,Cancellations,Cancellation rate (%)");
  });
});
