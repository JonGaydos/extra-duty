import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { accessReviewItems, apiKeys, assignments, auditLog, calendarTokens, invoices, jobs, notifications, spotOffers, users, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { authenticateApiKey, createApiKey } from "@/domain/api-keys/api-keys";
import { DEPARTURE_REMOVE_ACTION } from "@/domain/assignments/history";
import { checkSessionAllowed } from "@/domain/auth/sign-in-policy";
import { billAssignment } from "@/domain/billing/bill";
import { coordinatorTodo, jobAdmin } from "@/domain/coordinator/views";
import { ForbiddenError, UnauthenticatedError, ValidationError } from "@/domain/errors";
import { jobActivity, myDetails } from "@/domain/personnel/views";
import { rotateCalendarToken } from "@/domain/planning/ics-feed";
import { exportReport, runReport, type ReportSpec } from "@/domain/reports/engine";
import { DATASETS } from "@/domain/reports/datasets";
import { ACTIVITY_MEASURES } from "@/domain/reports/saved";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { writeOffDetail } from "@/domain/users/departure";
import { deactivateUser, departureChecklist, reactivateUser } from "@/domain/users/users";
import { decideAccessReviewItem, startAccessReview } from "@/domain/users/access-review";
import { vendorDetails } from "@/domain/vendor-portal/views";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "./helpers";

/** Mid-June 2035 in agency time: "today" for these tests. */
const NOW = agencyInstant(2035, 6, 15, 9, 0);
const LAST_DAY = "2035-06-10";
const FROM = agencyInstant(2035, 1, 1, 0, 0);
const TO = agencyInstant(2035, 12, 31, 23, 59);

describe("departure: deactivating someone who leaves the agency", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let vendor: Actor;
  let dana: Actor;
  let backupPerson: Actor;
  let other: Actor;
  const ids = {} as Record<"backedJob" | "lonelyJob" | "backupJob" | "lastDayJob" | "lateJob" | "billedJob" | "backedRow" | "lonelyRow" | "backupRow" | "lastDayRow" | "lateRow" | "billedRow" | "backupPersonRow" | "invoice", string>;

  /** A detail on an agency day (17:00 to 23:00), with `count` spots. */
  const jobOn = async (y: number, m: number, d: number, count = 1) => {
    const { job, positionId } = await f.mkJob({ count });
    await get().db.update(jobs).set({ startAt: agencyInstant(y, m, d, 17, 0), endAt: agencyInstant(y, m, d, 23, 0) }).where(eq(jobs.id, job.id));
    return { jobId: job.id, positionId };
  };
  const row = async (jobId: string, positionId: string, userId: string, status: "signed_up" | "backup" | "late_canceled", backupPosition: number | null = null) =>
    (await get().db.insert(assignments).values({ jobId, jobPositionId: positionId, userId, status, backupPosition }).returning())[0].id;
  const statusOf = async (id: string) => (await get().db.select().from(assignments).where(eq(assignments.id, id)))[0].status;

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "dep");
    admin = (await makeUser(db, "admin", "dep-admin@example.test")).actor;
    const v = await makeUser(db, "vendor", "dep-vendor@example.test");
    await db.insert(vendorUsers).values({ userId: v.row.id, vendorId: f.vendorId });
    vendor = { ...v.actor, vendorId: f.vendorId };
    dana = await f.person();
    backupPerson = await f.person();
    other = await f.person();
    await db.update(users).set({ name: "Dana Lane", mailingAddress: "1 Main St, Town, TX 75001", lastSignInAt: new Date() }).where(eq(users.id, dana.userId));
    await db.update(users).set({ name: "Bo Backup" }).where(eq(users.id, backupPerson.userId));
    await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: "all" }));

    // After the last day: a spot with a backup in line, a spot with no backup, and a place in a backup line.
    const backed = await jobOn(2035, 6, 20);
    ids.backedJob = backed.jobId;
    ids.backedRow = await row(backed.jobId, backed.positionId, dana.userId, "signed_up");
    ids.backupPersonRow = await row(backed.jobId, backed.positionId, backupPerson.userId, "backup", 1);
    const lonely = await jobOn(2035, 6, 22);
    ids.lonelyJob = lonely.jobId;
    ids.lonelyRow = await row(lonely.jobId, lonely.positionId, dana.userId, "signed_up");
    const inLine = await jobOn(2035, 6, 25);
    ids.backupJob = inLine.jobId;
    await row(inLine.jobId, inLine.positionId, other.userId, "signed_up");
    ids.backupRow = await row(inLine.jobId, inLine.positionId, dana.userId, "backup", 1);

    // On or before the last day: worked and not billed, a late cancel past its end, and a billed, unpaid invoice.
    const lastDay = await jobOn(2035, 6, 10);
    ids.lastDayJob = lastDay.jobId;
    ids.lastDayRow = await row(lastDay.jobId, lastDay.positionId, dana.userId, "signed_up");
    const late = await jobOn(2035, 6, 1);
    ids.lateJob = late.jobId;
    ids.lateRow = await row(late.jobId, late.positionId, dana.userId, "late_canceled");
    const billed = await jobOn(2035, 5, 20);
    ids.billedJob = billed.jobId;
    ids.billedRow = await row(billed.jobId, billed.positionId, dana.userId, "signed_up");
    const { invoice } = await f.run((tx) => billAssignment(dana, tx, ids.billedRow, { startAt: agencyInstant(2035, 5, 20, 17, 0), endAt: agencyInstant(2035, 5, 20, 23, 0), attachW9: false }, NOW));
    ids.invoice = invoice.id;
  });

  test("a reason and a last day are both required, and the last day cannot be in the future", async () => {
    const tryIt = (input: { reason: string; lastDay: string }) => f.run((tx) => deactivateUser(f.coord, tx, dana.userId, input, NOW));
    await expect(tryIt({ reason: " ", lastDay: LAST_DAY })).rejects.toThrow("A reason is required.");
    await expect(tryIt({ reason: "Moved away", lastDay: "" })).rejects.toThrow("Enter their last day.");
    await expect(tryIt({ reason: "Moved away", lastDay: "2035-02-30" })).rejects.toBeInstanceOf(ValidationError);
    await expect(tryIt({ reason: "Moved away", lastDay: "2035-06-16" })).rejects.toThrow("The last day cannot be in the future.");
    await expect(f.run((tx) => departureChecklist(f.coord, tx, dana.userId, "2035-06-16", NOW))).rejects.toThrow("The last day cannot be in the future.");
    // Today is allowed.
    const preview = await f.run((tx) => departureChecklist(f.coord, tx, dana.userId, "2035-06-15", NOW));
    expect(preview.upcoming.length).toBe(3);
  });

  test("the checklist lists upcoming sign-ups, unbilled past details and unpaid invoices, and writes nothing", async () => {
    const { db } = get();
    const audits = (await db.select().from(auditLog)).length;
    await expect(f.run((tx) => departureChecklist(other, tx, dana.userId, LAST_DAY, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    const c = await f.run((tx) => departureChecklist(f.coord, tx, dana.userId, LAST_DAY, NOW));
    expect(c.upcoming.map((u) => [u.assignmentId, u.status])).toEqual([
      [ids.backedRow, "signed_up"],
      [ids.lonelyRow, "signed_up"],
      [ids.backupRow, "backup"],
    ]);
    const [backedJob] = await db.select().from(jobs).where(eq(jobs.id, ids.backedJob));
    expect(c.upcoming[0]).toMatchObject({ jobId: ids.backedJob, jobNumber: backedJob.number, vendorName: "dep Vendor", position: "Deputy Sheriff", startAt: agencyInstant(2035, 6, 20, 17, 0) });
    expect(c.unbilled.map((u) => [u.assignmentId, u.lateCancel])).toEqual([
      [ids.lateRow, true],
      [ids.lastDayRow, false],
    ]);
    expect(c.unbilled[0]).toMatchObject({ jobId: ids.lateJob, vendorName: "dep Vendor" });
    expect(c.unpaid).toEqual([expect.objectContaining({ invoiceId: ids.invoice, status: "pending_review", totalCents: 42000, vendorName: "dep Vendor", jobId: ids.billedJob })]);
    expect((await db.select().from(auditLog)).length).toBe(audits);
    expect(await statusOf(ids.backedRow)).toBe("signed_up");
  });

  test("coordinators cannot turn off an admin; nobody can turn off themselves", async () => {
    await expect(f.run((tx) => deactivateUser(f.coord, tx, admin.userId, { reason: "Left", lastDay: LAST_DAY }, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => deactivateUser(f.coord, tx, f.coord.userId, { reason: "Left", lastDay: LAST_DAY }, NOW))).rejects.toThrow("You cannot deactivate your own account.");
  });

  test("on confirm: the account is off, only sign-ups after the last day are removed, and spots go to backups or reopen", async () => {
    const { db } = get();
    const before = await db.select().from(invoices).where(eq(invoices.id, ids.invoice));
    const notesBefore = (await db.select().from(notifications).where(eq(notifications.userId, dana.userId))).length;
    const r = await f.run((tx) => deactivateUser(f.coord, tx, dana.userId, { reason: "Moved out of state", lastDay: LAST_DAY }, NOW));

    expect(r.user).toMatchObject({ active: false, deactivationReason: "Moved out of state", lastDay: LAST_DAY, deactivatedBy: f.coord.userId });
    expect(r.removed.map((x) => x.assignmentId)).toEqual([ids.backedRow, ids.lonelyRow, ids.backupRow]);
    expect(r.unbilled.map((x) => x.assignmentId)).toEqual([ids.lateRow, ids.lastDayRow]);
    expect(r.unpaid.map((x) => x.invoiceId)).toEqual([ids.invoice]);

    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, dana.userId), eq(auditLog.action, "user.deactivate")));
    expect(audit.reason).toBe("Moved out of state");
    expect(audit.after).toMatchObject({ active: false, lastDay: LAST_DAY });

    for (const id of [ids.backedRow, ids.lonelyRow, ids.backupRow]) {
      expect(await statusOf(id)).toBe("removed");
      const acts = (await db.select().from(auditLog).where(eq(auditLog.entityId, id))).map((a) => a.action);
      expect(acts).toContain(DEPARTURE_REMOVE_ACTION);
      expect(acts).not.toContain("assignment.remove");
    }
    // Unbilled and unpaid items are untouched.
    expect(await statusOf(ids.lastDayRow)).toBe("signed_up");
    expect(await statusOf(ids.lateRow)).toBe("late_canceled");
    expect(await statusOf(ids.billedRow)).toBe("billed");
    expect(await db.select().from(invoices).where(eq(invoices.id, ids.invoice))).toEqual(before);

    // The backup in line is offered the spot; the spot with no backup is simply open again.
    const backedOffers = await db.select().from(spotOffers).innerJoin(assignments, eq(assignments.jobPositionId, spotOffers.jobPositionId)).where(eq(assignments.id, ids.backedRow));
    expect(backedOffers.map((o) => [o.spot_offers.offeredToAssignmentId, o.spot_offers.status])).toEqual([[ids.backupPersonRow, "open"]]);
    const lonelyOffers = await db.select().from(spotOffers).innerJoin(assignments, eq(assignments.jobPositionId, spotOffers.jobPositionId)).where(eq(assignments.id, ids.lonelyRow));
    expect(lonelyOffers).toEqual([]);
    const lonelyDetail = await f.run((tx) => jobAdmin(f.coord, tx, ids.lonelyJob));
    expect(lonelyDetail.positions[0].filled).toBe(0);

    // The person gets no alert: the account is off.
    expect((await db.select().from(notifications).where(eq(notifications.userId, dana.userId))).length).toBe(notesBefore);
  });

  test("the vendor and other deputies are never told why", async () => {
    const { db } = get();
    const rows = await f.run((tx) => vendorDetails(vendor, tx, { from: FROM, to: TO }, NOW));
    expect(rows.find((r) => r.id === ids.lonelyJob)).toMatchObject({ filled: 0 });
    expect(JSON.stringify(rows)).not.toMatch(/left the agency|moved out|depart/i);
    const sent = await db.select().from(notifications).where(inArray(notifications.userId, [vendor.userId, backupPerson.userId, other.userId]));
    for (const n of sent) expect(`${n.title} ${n.body}`).not.toMatch(/left the agency|moved out|depart|deactivat/i);
    const feed = await f.run((tx) => jobActivity(other, tx, ids.backupJob));
    expect(feed.map((x) => x.text)).toContain("Dana Lane had a sign-up canceled");
    expect(JSON.stringify(feed)).not.toMatch(/left the agency|moved out|depart/i);
  });

  test("staff see Left the agency on the detail's sign-up history", async () => {
    for (const who of [f.coord, admin]) {
      const detail = await f.run((tx) => jobAdmin(who, tx, ids.lonelyJob));
      expect(detail.roster.map((r) => [r.name, r.label])).toEqual([["Dana Lane", "Left the agency"]]);
    }
  });

  const spec = (): ReportSpec => ({ dataset: "activity", from: FROM, to: TO, filters: { userIds: [dana.userId] }, groupBy: ["deputy"], measures: [...ACTIVITY_MEASURES] });

  test("the activity report shows Left the agency, to staff only, and never as a removal or a cancellation", async () => {
    expect(ACTIVITY_MEASURES).toContain("departure_removals");
    expect(DATASETS.activity.measures).toContain("departure_removals");
    const r = await f.run((tx) => runReport(f.coord, tx, spec()));
    const rows = Object.fromEntries(r.rows.map((row) => [row[0] as string, Object.fromEntries(r.columns.slice(1).map((c, i) => [c, row[i + 1]]))]));
    expect(rows["Dana Lane"]).toMatchObject({ departure_removals: 3, removals: 0, suspension_removals: 0, cancellations: 0, cancellation_rate: 0 });
    const csv = (await f.run((tx) => exportReport(f.coord, tx, spec(), "csv"))).toString("utf8");
    expect(csv.trim().split(/\r?\n/)[0]).toBe(
      "Person,Details worked,Hours worked,Earnings ($),Sign-ups,Gave away,Vendor late cancel,Removed by coordinator,Removed by suspension,Left the agency,No-shows,Cancellations,Cancellation rate (%)",
    );
    await expect(f.run((tx) => runReport(other, tx, spec()))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("unbilled past details stay on the coordinator to-do; staff can bill for the person or write a detail off with a reason", async () => {
    const { db } = get();
    const todo = await f.run((tx) => coordinatorTodo(f.coord, tx, NOW));
    expect(todo.departed.filter((d) => d.userId === dana.userId).map((d) => [d.assignmentId, d.name])).toEqual([
      [ids.lateRow, "Dana Lane"],
      [ids.lastDayRow, "Dana Lane"],
    ]);

    await expect(f.run((tx) => writeOffDetail(f.coord, tx, ids.lateRow, "  ", NOW))).rejects.toThrow("A reason is required.");
    await expect(f.run((tx) => writeOffDetail(other, tx, ids.lateRow, "Vendor closed", NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await f.run((tx) => writeOffDetail(f.coord, tx, ids.lateRow, "Vendor closed", NOW));
    const [wo] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, ids.lateRow), eq(auditLog.action, "assignment.write_off")));
    expect(wo.reason).toBe("Vendor closed");
    await expect(f.run((tx) => writeOffDetail(f.coord, tx, ids.lateRow, "Again", NOW))).rejects.toBeInstanceOf(ValidationError);
    await expect(f.run((tx) => billAssignment(f.coord, tx, ids.lateRow, { startAt: NOW, endAt: NOW, attachW9: false }, NOW))).rejects.toThrow(/written off/i);

    // The coordinator bills the last-day detail on the person's behalf, through the usual billing path.
    await f.run((tx) => billAssignment(f.coord, tx, ids.lastDayRow, { startAt: agencyInstant(2035, 6, 10, 17, 0), endAt: agencyInstant(2035, 6, 10, 23, 0), attachW9: false }, NOW));
    const after = await f.run((tx) => coordinatorTodo(f.coord, tx, NOW));
    expect(after.departed.filter((d) => d.userId === dana.userId)).toEqual([]);
  });

  test("reactivation needs a reason, restores no sign-ups, and the person can sign in again", async () => {
    const { db } = get();
    await expect(f.run((tx) => reactivateUser(f.coord, tx, dana.userId, " "))).rejects.toThrow("A reason is required.");
    await expect(f.run((tx) => reactivateUser(other, tx, dana.userId, "Came back"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await checkSessionAllowed(db, dana.userId)).toBe("ACCOUNT_DISABLED");
    const u = await f.run((tx) => reactivateUser(f.coord, tx, dana.userId, "Came back"));
    expect(u).toMatchObject({ active: true, deactivatedAt: null, deactivationReason: null, lastDay: null });
    const [audit] = await db.select().from(auditLog).where(and(eq(auditLog.entityId, dana.userId), eq(auditLog.action, "user.reactivate")));
    expect(audit.reason).toBe("Came back");
    for (const id of [ids.backedRow, ids.lonelyRow, ids.backupRow]) expect(await statusOf(id)).toBe("removed");
    expect(await checkSessionAllowed(db, dana.userId)).toBeNull();
    await expect(f.run((tx) => reactivateUser(f.coord, tx, dana.userId, "Again"))).rejects.toThrow("This account is already active.");

    // Their own list reads a plain cancellation, never why.
    const mine = await f.run((tx) => myDetails(dana, tx, NOW));
    expect(mine.find((d) => d.assignmentId === ids.lonelyRow)).toMatchObject({ status: "canceled", label: "Canceled", reason: "Your sign-up was canceled." });
    expect(JSON.stringify(mine)).not.toMatch(/left the agency|moved out|depart/i);
  });

  test("calendar feeds and API keys stay revoked after reactivation; the last active admin cannot be turned off", async () => {
    const { db } = get();
    const second = await makeUser(db, "admin", "dep-admin2@example.test");
    await db.update(users).set({ active: false }).where(eq(users.id, admin.userId));
    // Only `second` and the admin below are active admins now.
    const keyAdmin = await makeUser(db, "admin", "dep-admin3@example.test");
    const { key } = await f.run((tx) => createApiKey(keyAdmin.actor, tx, { name: "Payroll export", scopes: ["read"] }));
    await f.run((tx) => rotateCalendarToken(keyAdmin.actor, tx));
    await f.run((tx) => deactivateUser(second.actor, tx, keyAdmin.row.id, { reason: "Retired", lastDay: "2026-01-02" }));
    expect((await db.select().from(apiKeys).where(eq(apiKeys.createdBy, keyAdmin.row.id)))[0].revokedAt).not.toBeNull();
    await f.run((tx) => reactivateUser(second.actor, tx, keyAdmin.row.id, "Back part time"));
    await expect(f.run((tx) => authenticateApiKey(tx, key, { method: "GET", path: "/api/v1/users" }))).rejects.toBeInstanceOf(UnauthenticatedError);
    expect((await db.select().from(calendarTokens).where(eq(calendarTokens.userId, keyAdmin.row.id))).every((t) => t.revokedAt !== null)).toBe(true);

    // second turns keyAdmin off again; then keyAdmin (signed in elsewhere a moment ago) cannot turn off the last active admin.
    await f.run((tx) => deactivateUser(second.actor, tx, keyAdmin.row.id, { reason: "Retired", lastDay: "2026-01-02" }));
    await expect(f.run((tx) => deactivateUser(keyAdmin.actor, tx, second.row.id, { reason: "Left", lastDay: "2026-01-02" }))).rejects.toThrow(
      "At least one active admin is needed. Make someone else an admin first.",
    );
    await db.update(users).set({ active: true }).where(eq(users.id, admin.userId));
  });

  test("the access review's Deactivate decision uses the same flow, asking for the last day", async () => {
    const { db } = get();
    const leaver = await f.person();
    const { jobId, positionId } = await jobOn(2035, 7, 1);
    const rowId = await row(jobId, positionId, leaver.userId, "signed_up");
    const review = await f.run((tx) => startAccessReview(tx, NOW, f.coord));
    expect(review).not.toBeNull();
    const [item] = await db.select().from(accessReviewItems).where(eq(accessReviewItems.userId, leaver.userId));
    await expect(f.run((tx) => decideAccessReviewItem(f.coord, tx, item.id, { decision: "deactivate" }, NOW))).rejects.toThrow("Enter their last day.");
    await f.run((tx) => decideAccessReviewItem(f.coord, tx, item.id, { decision: "deactivate", lastDay: "2035-06-14" }, NOW));
    const [u] = await db.select().from(users).where(eq(users.id, leaver.userId));
    expect(u).toMatchObject({ active: false, deactivationReason: "Access review", lastDay: "2035-06-14" });
    expect(await statusOf(rowId)).toBe("removed");
  });

  test("a backdated last day keeps worked and in-progress details after it, lists them as unbilled, and the preview equals the confirm result", async () => {
    const { db } = get();
    const max = await f.person();
    const at = async (y: number, m: number, d: number, sh: number, eh: number, status: "signed_up" | "late_canceled") => {
      const { job, positionId } = await f.mkJob();
      await db.update(jobs).set({ startAt: agencyInstant(y, m, d, sh, 0), endAt: agencyInstant(y, m, d, eh, 0) }).where(eq(jobs.id, job.id));
      return row(job.id, positionId, max.userId, status);
    };
    // Last day 06-10; today is 06-15 at 09:00.
    const worked = await at(2035, 6, 12, 17, 23, "signed_up");
    const lateCancel = await at(2035, 6, 13, 17, 23, "late_canceled");
    const inProgress = await at(2035, 6, 15, 8, 12, "signed_up");
    const upcoming = await at(2035, 6, 21, 17, 23, "signed_up");

    const preview = await f.run((tx) => departureChecklist(f.coord, tx, max.userId, LAST_DAY, NOW));
    expect(preview.upcoming.map((u) => u.assignmentId)).toEqual([upcoming]);
    expect(preview.unbilled.map((u) => u.assignmentId)).toEqual([worked, lateCancel]);

    const r = await f.run((tx) => deactivateUser(f.coord, tx, max.userId, { reason: "Moved", lastDay: LAST_DAY }, NOW));
    expect(r.removed).toEqual(preview.upcoming);
    expect(r.unbilled).toEqual(preview.unbilled);
    expect(r.unpaid).toEqual(preview.unpaid);
    expect(await statusOf(worked)).toBe("signed_up");
    expect(await statusOf(lateCancel)).toBe("late_canceled");
    expect(await statusOf(inProgress)).toBe("signed_up");
    expect(await statusOf(upcoming)).toBe("removed");
  });
});
