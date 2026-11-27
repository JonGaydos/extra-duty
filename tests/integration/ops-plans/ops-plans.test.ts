import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import {
  assignments,
  auditLog,
  jobPositions,
  jobs,
  notifications,
  opsPlanVersions,
  opsPlans,
  qualifications,
  userQualifications,
  vendors,
} from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import {
  currentIc,
  getJobOpsPlan,
  nameIc,
  opsPlanDueAt,
  readOpsPlanVersion,
  reviewOpsPlan,
  submitOpsPlan,
} from "@/domain/ops-plans/ops-plans";
import { searchLibrary } from "@/domain/ops-plans/library";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { opsPlanRemindersTick } from "@/jobs/ops-plan-reminders";
import { createLocalStorage } from "@/lib/storage/local";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const PDF = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(64, 1)]);
const DOCX = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.alloc(64, 2)]);
const DOC = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(64, 3)]);
const pdf = (name = "plan.pdf") => ({ filename: name, contentType: "application/pdf", body: PDF });

describe("ops plans", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let reviewer: Actor;
  let reviewer2: Actor;
  let coord2: Actor;
  let icQualId: string;
  let icPos: string;
  let storage: ReturnType<typeof createLocalStorage>;

  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);
  const setReviewers = (ids: string[]) => run((tx) => updateSettings(admin, tx, { opsPlanReviewerUserIds: ids }));
  const inbox = (userId: string, type: string, link?: string) =>
    get().db
      .select()
      .from(notifications)
      .where(and(eq(notifications.userId, userId), eq(notifications.type, type), ...(link ? [eq(notifications.link, link)] : [])));

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "ops");
    admin = (await makeUser(db, "admin", "ops-admin@example.test")).actor;
    reviewer = (await makeUser(db, "personnel", "ops-reviewer@example.test", { rankId: fx.rank["Deputy Sheriff"] })).actor;
    reviewer2 = (await makeUser(db, "coordinator", "ops-reviewer2@example.test")).actor;
    coord2 = (await makeUser(db, "coordinator", "ops-coord2@example.test")).actor;
    icQualId = (await db.select().from(qualifications).where(eq(qualifications.name, "Incident Commander")))[0].id;
    icPos = fx.pos["Incident Commander"];
    storage = createLocalStorage(await mkdtemp(join(tmpdir(), "extra-duty-ops-")));
    await setReviewers([reviewer.userId, reviewer2.userId]);
  });

  /** A job that needs an ops plan, due 72 hours before start, with an Incident Commander spot. */
  async function mkOpsJob(o: { startAt?: Date; vendor?: string; title?: string } = {}) {
    const { db } = get();
    const { job } = await fx.mkJob({ vendor: o.vendor });
    const startAt = o.startAt ?? job.startAt;
    await db
      .update(jobs)
      .set({ opsPlanRequired: true, startAt, endAt: new Date(startAt.getTime() + 6 * HOUR), opsPlanDueAt: new Date(startAt.getTime() - 72 * HOUR), ...(o.title ? { title: o.title } : {}) })
      .where(eq(jobs.id, job.id));
    const [icSpot] = await db.insert(jobPositions).values({ jobId: job.id, positionTypeId: icPos, count: 1 }).returning();
    const row = (await db.select().from(jobs).where(eq(jobs.id, job.id)))[0];
    return { job: row, icSpot: icSpot.id };
  }
  async function mkIc(spot: { job: { id: string }; icSpot: string }) {
    const p = await fx.person();
    await get().db.insert(userQualifications).values({ userId: p.userId, qualificationId: icQualId });
    const [a] = await get().db.insert(assignments).values({ jobId: spot.job.id, jobPositionId: spot.icSpot, userId: p.userId, status: "signed_up" }).returning();
    return { ic: p, assignment: a };
  }
  /** A roster member (regular position) who holds the IC qualification. */
  async function mkRosterIc(job: { id: string }) {
    const p = await fx.person();
    await get().db.insert(userQualifications).values({ userId: p.userId, qualificationId: icQualId });
    const [pos] = await get().db.select().from(jobPositions).where(and(eq(jobPositions.jobId, job.id), eq(jobPositions.positionTypeId, fx.pos["Deputy Sheriff"])));
    const [a] = await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: pos.id, userId: p.userId, status: "signed_up" }).returning();
    return { p, a };
  }
  const submit = (actor: Actor, jobId: string, file = pdf()) => run((tx) => submitOpsPlan(actor, tx, jobId, file, storage));
  const planOf = async (jobId: string) => (await get().db.select().from(opsPlans).where(eq(opsPlans.jobId, jobId)))[0];

  test("a person who is not the Incident Commander cannot submit", async () => {
    const m = await mkOpsJob();
    const { ic } = await mkIc(m);
    const other = await fx.person();
    await expect(submit(other, m.job.id)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submit(fx.coord, m.job.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(await planOf(m.job.id)).toBeUndefined();
    await submit(ic, m.job.id);
  });

  test("a job that does not need an ops plan refuses a submission", async () => {
    const { job, positionId } = await fx.mkJob();
    const p = await fx.person();
    await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up", isIncidentCommander: true });
    await expect(submit(p, job.id)).rejects.toBeInstanceOf(ValidationError);
  });

  test("submitting stores a version, marks the plan submitted and alerts the reviewers", async () => {
    const m = await mkOpsJob({ title: "Spring parade" });
    const { ic } = await mkIc(m);
    expect((await run((tx) => getJobOpsPlan(fx.coord, tx, m.job.id))).status).toBe("not_started");
    const v = await submit(ic, m.job.id);
    expect(v.decision).toBe("pending");
    const plan = await planOf(m.job.id);
    expect(plan).toMatchObject({ status: "submitted", vendorId: m.job.vendorId, eventName: "Spring parade", year: 2035 });
    const link = `/jobs/${m.job.id}`;
    expect(await inbox(reviewer.userId, "ops_plan.submitted", link)).toHaveLength(1);
    expect(await inbox(reviewer2.userId, "ops_plan.submitted", link)).toHaveLength(1);
    expect(await inbox(ic.userId, "ops_plan.submitted", link)).toHaveLength(0);
    const audit = await get().db.select().from(auditLog).where(eq(auditLog.entityId, plan.id));
    expect(audit.map((r) => r.action)).toContain("ops_plan.submit");
    const detail = await run((tx) => getJobOpsPlan(fx.coord, tx, m.job.id));
    expect(detail.status).toBe("submitted");
    expect(detail.versions).toHaveLength(1);
  });

  test("uploads: PDF, DOCX and DOC are accepted; other types and files over 20 MB are refused", async () => {
    const m = await mkOpsJob();
    const { ic } = await mkIc(m);
    await submit(ic, m.job.id, { filename: "a.docx", contentType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", body: DOCX });
    await submit(ic, m.job.id, { filename: "b.doc", contentType: "application/msword", body: DOC });
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
    await expect(submit(ic, m.job.id, { filename: "c.png", contentType: "image/png", body: png })).rejects.toBeInstanceOf(ValidationError);
    await expect(submit(ic, m.job.id, { filename: "d.doc", contentType: "application/msword", body: PDF })).rejects.toBeInstanceOf(ValidationError);
    const big = Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(20 * 1024 * 1024)]);
    await expect(submit(ic, m.job.id, { filename: "e.pdf", contentType: "application/pdf", body: big })).rejects.toBeInstanceOf(ValidationError);
    const versions = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, (await planOf(m.job.id)).id));
    expect(versions).toHaveLength(2);
  });

  test("when the IC cancels, currentIc changes and a newly named IC takes over the task", async () => {
    const m = await mkOpsJob();
    const { ic, assignment } = await mkIc(m);
    const { p: roster, a: rosterA } = await mkRosterIc(m.job);
    const unqualified = await fx.person();
    const [pos] = await get().db.select().from(jobPositions).where(and(eq(jobPositions.jobId, m.job.id), eq(jobPositions.positionTypeId, fx.pos["Deputy Sheriff"])));
    await get().db.insert(assignments).values({ jobId: m.job.id, jobPositionId: pos.id, userId: unqualified.userId, status: "signed_up" });
    await run(async (tx) => expect(await currentIc(tx, m.job.id)).toBe(ic.userId));
    await submit(ic, m.job.id);
    await get().db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, assignment.id));
    await run(async (tx) => expect(await currentIc(tx, m.job.id)).toBeNull());
    await expect(submit(ic, m.job.id)).rejects.toBeInstanceOf(ForbiddenError);
    // naming rules
    await expect(run((tx) => nameIc(roster, tx, m.job.id, roster.userId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => nameIc(fx.coord, tx, m.job.id, unqualified.userId))).rejects.toBeInstanceOf(ValidationError);
    const stranger = await fx.person();
    await get().db.insert(userQualifications).values({ userId: stranger.userId, qualificationId: icQualId });
    await expect(run((tx) => nameIc(fx.coord, tx, m.job.id, stranger.userId))).rejects.toBeInstanceOf(ValidationError);
    await run((tx) => nameIc(fx.coord, tx, m.job.id, roster.userId));
    await run(async (tx) => expect(await currentIc(tx, m.job.id)).toBe(roster.userId));
    const [flagged] = await get().db.select().from(assignments).where(eq(assignments.id, rosterA.id));
    expect(flagged.isIncidentCommander).toBe(true);
    // the plan the old IC submitted stays with the job; the new IC resubmits as version 2
    expect((await planOf(m.job.id)).status).toBe("submitted");
    await submit(roster, m.job.id);
    const versions = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, (await planOf(m.job.id)).id));
    expect(versions).toHaveLength(2);
  });

  test("nameIc refuses a person not on the roster, without the qualification, or when an IC position is filled by someone else", async () => {
    const m = await mkOpsJob();
    const { ic } = await mkIc(m);
    const { p: roster } = await mkRosterIc(m.job);
    await expect(run((tx) => nameIc(fx.coord, tx, m.job.id, roster.userId))).rejects.toThrow("position is filled");
    await run(async (tx) => expect(await currentIc(tx, m.job.id)).toBe(ic.userId));
    const [flagged] = await get().db.select().from(assignments).where(and(eq(assignments.jobId, m.job.id), eq(assignments.userId, roster.userId)));
    expect(flagged.isIncidentCommander).toBe(false);
    const off = await fx.person();
    await get().db.insert(userQualifications).values({ userId: off.userId, qualificationId: icQualId });
    await expect(run((tx) => nameIc(fx.coord, tx, m.job.id, off.userId))).rejects.toThrow("signed up");
    const m2 = await mkOpsJob();
    const noQual = await fx.person();
    const [pos] = await get().db.select().from(jobPositions).where(and(eq(jobPositions.jobId, m2.job.id), eq(jobPositions.positionTypeId, fx.pos["Deputy Sheriff"])));
    await get().db.insert(assignments).values({ jobId: m2.job.id, jobPositionId: pos.id, userId: noQual.userId, status: "signed_up" });
    await expect(run((tx) => nameIc(fx.coord, tx, m2.job.id, noQual.userId))).rejects.toThrow("qualification");
  });

  test("a stale review is refused, and a resubmission while pending leaves the older version pending but not reviewable", async () => {
    const m = await mkOpsJob();
    const { ic } = await mkIc(m);
    const v1 = await submit(ic, m.job.id);
    const v2 = await submit(ic, m.job.id);
    const plan = await planOf(m.job.id);
    await expect(run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "agreed", comments: "", versionId: v1.id }))).rejects.toThrow("newer version");
    const stored = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, plan.id));
    expect(stored.find((v) => v.id === v1.id)!.decision).toBe("pending");
    await run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "agreed", comments: "", versionId: v2.id }));
    const after = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, plan.id));
    expect(after.find((v) => v.id === v2.id)!.decision).toBe("agreed");
    expect(after.find((v) => v.id === v1.id)!.decision).toBe("pending");
  });

  test("a reviewer who is the submitting IC is refused; a non-reviewer coordinator is refused", async () => {
    const m = await mkOpsJob();
    const ic = await fx.person();
    await get().db.insert(userQualifications).values({ userId: ic.userId, qualificationId: icQualId });
    await get().db.insert(assignments).values({ jobId: m.job.id, jobPositionId: m.icSpot, userId: ic.userId, status: "signed_up" });
    await setReviewers([reviewer.userId, reviewer2.userId, ic.userId]);
    try {
      await submit(ic, m.job.id);
      const plan = await planOf(m.job.id);
      await expect(run((tx) => reviewOpsPlan(ic, tx, plan.id, { decision: "agreed", comments: "" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run((tx) => reviewOpsPlan(fx.coord, tx, plan.id, { decision: "agreed", comments: "" }))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run((tx) => reviewOpsPlan(admin, tx, plan.id, { decision: "agreed", comments: "" }))).rejects.toBeInstanceOf(ForbiddenError);
      expect((await planOf(m.job.id)).status).toBe("submitted");
      // the IC, though a reviewer, gets no reviewer alert for their own plan
      expect(await inbox(ic.userId, "ops_plan.submitted")).toHaveLength(0);
    } finally {
      await setReviewers([reviewer.userId, reviewer2.userId]);
    }
  });

  test("denying needs comments, alerts the IC and sends the plan back; agreeing records who and when", async () => {
    const m = await mkOpsJob();
    const { ic } = await mkIc(m);
    await submit(ic, m.job.id);
    const plan = await planOf(m.job.id);
    await expect(run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "denied", comments: "  " }))).rejects.toBeInstanceOf(ValidationError);
    await run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "denied", comments: "Add a medical plan." }));
    expect((await planOf(m.job.id)).status).toBe("denied");
    expect(await inbox(ic.userId, "ops_plan.denied", `/jobs/${m.job.id}`)).toHaveLength(1);
    // a decided version cannot be decided again
    await expect(run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "agreed", comments: "" }))).rejects.toBeInstanceOf(ValidationError);
    await submit(ic, m.job.id);
    expect(await inbox(reviewer.userId, "ops_plan.resubmitted", `/jobs/${m.job.id}`)).toHaveLength(1);
    expect((await planOf(m.job.id)).status).toBe("submitted");
    await run((tx) => reviewOpsPlan(reviewer2, tx, plan.id, { decision: "agreed", comments: "Looks good." }));
    expect((await planOf(m.job.id)).status).toBe("agreed");
    const versions = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, plan.id)).orderBy(opsPlanVersions.submittedAt, opsPlanVersions.id);
    expect(versions.map((v) => v.decision)).toEqual(["denied", "agreed"]);
    expect(versions[0]).toMatchObject({ decidedBy: reviewer.userId, comments: "Add a medical plan." });
    expect(versions[1]).toMatchObject({ decidedBy: reviewer2.userId });
    expect(versions[1].decidedAt).toBeInstanceOf(Date);
    expect(await inbox(ic.userId, "ops_plan.agreed", `/jobs/${m.job.id}`)).toHaveLength(1);
    expect((await get().db.select().from(auditLog).where(eq(auditLog.entityId, plan.id))).map((r) => r.action)).toContain("ops_plan.review");
  });

  test("a resubmission after agreed needs review again and creates version 2", async () => {
    const m = await mkOpsJob();
    const { ic } = await mkIc(m);
    await submit(ic, m.job.id);
    const plan = await planOf(m.job.id);
    await run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "agreed", comments: "" }));
    expect((await planOf(m.job.id)).status).toBe("agreed");
    await submit(ic, m.job.id);
    expect((await planOf(m.job.id)).status).toBe("submitted");
    const versions = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, plan.id));
    expect(versions).toHaveLength(2);
    expect(await inbox(reviewer.userId, "ops_plan.resubmitted", `/jobs/${m.job.id}`)).toHaveLength(1);
    await run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "agreed", comments: "" }));
  });

  test("an IC assigned after the due date has until the detail's start", () => {
    const startAt = agencyInstant(2035, 6, 10, 18, 0);
    const dueAt = new Date(startAt.getTime() - 72 * HOUR);
    const job = { startAt, opsPlanDueAt: dueAt };
    expect(opsPlanDueAt(job, new Date(dueAt.getTime() - HOUR))).toEqual(dueAt);
    expect(opsPlanDueAt(job, dueAt)).toEqual(dueAt);
    expect(opsPlanDueAt(job, new Date(dueAt.getTime() + HOUR))).toEqual(startAt);
  });

  describe("reminders", () => {
    const START = agencyInstant(2035, 8, 1, 18, 0);
    const DUE = new Date(START.getTime() - 72 * HOUR);

    test("due soon and overdue go to the IC and coordinators once each", async () => {
      const m = await mkOpsJob({ startAt: START });
      const { ic } = await mkIc(m);
      const link = `/jobs/${m.job.id}`;
      await opsPlanRemindersTick(new Date(DUE.getTime() - 27 * HOUR));
      expect(await inbox(ic.userId, "ops_plan.due_soon", link)).toHaveLength(0);
      const soon = new Date(DUE.getTime() - 23 * HOUR);
      await opsPlanRemindersTick(soon);
      await opsPlanRemindersTick(new Date(soon.getTime() + HOUR));
      expect(await inbox(ic.userId, "ops_plan.due_soon", link)).toHaveLength(1);
      expect(await inbox(fx.coord.userId, "ops_plan.due_soon", link)).toHaveLength(1);
      expect(await inbox(coord2.userId, "ops_plan.due_soon", link)).toHaveLength(1);
      expect(await inbox(admin.userId, "ops_plan.due_soon", link)).toHaveLength(1);
      expect(await inbox(ic.userId, "ops_plan.overdue", link)).toHaveLength(0);
      const late = new Date(DUE.getTime() + HOUR);
      await opsPlanRemindersTick(late);
      await opsPlanRemindersTick(new Date(late.getTime() + DAY));
      expect(await inbox(ic.userId, "ops_plan.overdue", link)).toHaveLength(1);
      expect(await inbox(fx.coord.userId, "ops_plan.overdue", link)).toHaveLength(1);
      expect(await inbox(ic.userId, "ops_plan.due_soon", link)).toHaveLength(1);
    });

    test("the due alerts name the job and say when no Incident Commander is set", async () => {
      const withIc = await mkOpsJob({ startAt: START });
      const { ic } = await mkIc(withIc);
      const without = await mkOpsJob({ startAt: START });
      await opsPlanRemindersTick(new Date(DUE.getTime() - 23 * HOUR));
      await opsPlanRemindersTick(new Date(DUE.getTime() + HOUR));
      const text = async (type: string, job: typeof withIc) =>
        (await inbox(fx.coord.userId, type, `/jobs/${job.job.id}`)).map((n) => [n.title, n.body]);
      expect(await text("ops_plan.due_soon", withIc)).toEqual([[`Ops plan due soon: Detail #${withIc.job.number}`, `${withIc.job.title}: the ops plan is due soon.`]]);
      expect(await text("ops_plan.overdue", withIc)).toEqual([[`Ops plan overdue: Detail #${withIc.job.number}`, `${withIc.job.title}: the ops plan is overdue.`]]);
      expect(await inbox(ic.userId, "ops_plan.overdue", `/jobs/${withIc.job.id}`)).toHaveLength(1);
      expect(await text("ops_plan.due_soon", without)).toEqual([[`Ops plan due soon: Detail #${without.job.number}`, `${without.job.title}: the ops plan is due soon and the detail has no Incident Commander.`]]);
      expect(await text("ops_plan.overdue", without)).toEqual([[`Ops plan overdue: Detail #${without.job.number}`, `${without.job.title}: the ops plan is overdue and the detail has no Incident Commander.`]]);
    });

    test("a submitted plan sends no due alerts", async () => {
      const m = await mkOpsJob({ startAt: START });
      const { ic } = await mkIc(m);
      await submit(ic, m.job.id);
      await opsPlanRemindersTick(new Date(DUE.getTime() + HOUR));
      expect(await inbox(ic.userId, "ops_plan.overdue", `/jobs/${m.job.id}`)).toHaveLength(0);
      expect(await inbox(fx.coord.userId, "ops_plan.overdue", `/jobs/${m.job.id}`)).toHaveLength(0);
    });

    test("an unreviewed plan reminds reviewers once a day until reviewed, never the submitting IC", async () => {
      const m = await mkOpsJob({ startAt: START });
      const ic = await fx.person();
      await get().db.insert(userQualifications).values({ userId: ic.userId, qualificationId: icQualId });
      await get().db.insert(assignments).values({ jobId: m.job.id, jobPositionId: m.icSpot, userId: ic.userId, status: "signed_up" });
      await setReviewers([reviewer.userId, reviewer2.userId, ic.userId]);
      try {
        await submit(ic, m.job.id);
        const link = `/jobs/${m.job.id}`;
        const day1 = agencyInstant(2035, 7, 1, 7, 40);
        await opsPlanRemindersTick(day1);
        await opsPlanRemindersTick(new Date(day1.getTime() + HOUR));
        expect(await inbox(reviewer.userId, "ops_plan.review_waiting", link)).toHaveLength(1);
        expect(await inbox(ic.userId, "ops_plan.review_waiting", link)).toHaveLength(0);
        await opsPlanRemindersTick(new Date(day1.getTime() + DAY));
        expect(await inbox(reviewer.userId, "ops_plan.review_waiting", link)).toHaveLength(2);
        expect(await inbox(reviewer2.userId, "ops_plan.review_waiting", link)).toHaveLength(2);
        const plan = await planOf(m.job.id);
        await run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "agreed", comments: "" }));
        await opsPlanRemindersTick(new Date(day1.getTime() + 2 * DAY));
        expect(await inbox(reviewer.userId, "ops_plan.review_waiting", link)).toHaveLength(2);
      } finally {
        await setReviewers([reviewer.userId, reviewer2.userId]);
      }
    });

    test("a reviewer who became the IC after submission gets no reminders and cannot review", async () => {
      const m = await mkOpsJob({ startAt: START });
      const { ic, assignment } = await mkIc(m);
      const { p: newIc } = await mkRosterIc(m.job);
      await setReviewers([reviewer.userId, newIc.userId]);
      try {
        await submit(ic, m.job.id);
        await get().db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, assignment.id));
        await run((tx) => nameIc(fx.coord, tx, m.job.id, newIc.userId));
        const link = `/jobs/${m.job.id}`;
        await opsPlanRemindersTick(agencyInstant(2035, 7, 1, 7, 40));
        expect(await inbox(reviewer.userId, "ops_plan.review_waiting", link)).toHaveLength(1);
        expect(await inbox(newIc.userId, "ops_plan.review_waiting", link)).toHaveLength(0);
        const plan = await planOf(m.job.id);
        await expect(run((tx) => reviewOpsPlan(newIc, tx, plan.id, { decision: "agreed", comments: "" }))).rejects.toBeInstanceOf(ForbiddenError);
      } finally {
        await setReviewers([reviewer.userId, reviewer2.userId]);
      }
    });

    test("canceled jobs get no due or review reminders", async () => {
      const a = await mkOpsJob({ startAt: START });
      const { ic: icA } = await mkIc(a);
      const b = await mkOpsJob({ startAt: START });
      const { ic: icB } = await mkIc(b);
      await submit(icB, b.job.id);
      await get().db.update(jobs).set({ state: "canceled" }).where(inArray(jobs.id, [a.job.id, b.job.id]));
      await opsPlanRemindersTick(new Date(DUE.getTime() + HOUR));
      await opsPlanRemindersTick(agencyInstant(2035, 7, 1, 7, 40));
      expect(await inbox(icA.userId, "ops_plan.overdue", `/jobs/${a.job.id}`)).toHaveLength(0);
      expect(await inbox(reviewer.userId, "ops_plan.review_waiting", `/jobs/${b.job.id}`)).toHaveLength(0);
    });

    test("due soon is not skipped when daily ticks are 25 hours apart", async () => {
      const m = await mkOpsJob({ startAt: START });
      const { ic } = await mkIc(m);
      const link = `/jobs/${m.job.id}`;
      await opsPlanRemindersTick(new Date(DUE.getTime() - 27 * HOUR));
      expect(await inbox(ic.userId, "ops_plan.due_soon", link)).toHaveLength(0);
      await opsPlanRemindersTick(new Date(DUE.getTime() - 25.5 * HOUR + 0));
      expect(await inbox(ic.userId, "ops_plan.due_soon", link)).toHaveLength(1);
    });

    test("with no reviewers set, submission works and coordinators are told once per submission", async () => {
      const m = await mkOpsJob({ startAt: START });
      const { ic } = await mkIc(m);
      await setReviewers([]);
      try {
        const link = `/jobs/${m.job.id}`;
        await submit(ic, m.job.id);
        expect(await inbox(fx.coord.userId, "ops_plan.no_reviewers", link)).toHaveLength(1);
        expect(await inbox(admin.userId, "ops_plan.no_reviewers", link)).toHaveLength(1);
        await opsPlanRemindersTick(agencyInstant(2035, 7, 2, 7, 40));
        expect(await inbox(fx.coord.userId, "ops_plan.no_reviewers", link)).toHaveLength(1);
        await submit(ic, m.job.id);
        expect(await inbox(fx.coord.userId, "ops_plan.no_reviewers", link)).toHaveLength(2);
      } finally {
        await setReviewers([reviewer.userId, reviewer2.userId]);
      }
    });

    test("when the IC changes the due date follows the new IC's assignment time", async () => {
      const m = await mkOpsJob({ startAt: START });
      const { assignment } = await mkIc(m);
      await get().db.update(assignments).set({ status: "canceled" }).where(eq(assignments.id, assignment.id));
      const { p, a } = await mkRosterIc(m.job);
      await run((tx) => nameIc(fx.coord, tx, m.job.id, p.userId));
      await get().db.update(assignments).set({ icAssignedAt: new Date(DUE.getTime() + 2 * DAY) }).where(eq(assignments.id, a.id));
      const link = `/jobs/${m.job.id}`;
      await opsPlanRemindersTick(new Date(DUE.getTime() + HOUR));
      expect(await inbox(p.userId, "ops_plan.overdue", link)).toHaveLength(0);
      await opsPlanRemindersTick(new Date(START.getTime() + HOUR));
      expect(await inbox(p.userId, "ops_plan.overdue", link)).toHaveLength(1);
    });
  });

  describe("library", () => {
    const PAST = agencyInstant(2020, 4, 4, 9, 0);

    async function agreedPast(title: string, vendorId?: string, startAt = PAST) {
      const m = await mkOpsJob({ startAt, title, vendor: vendorId });
      const { ic } = await mkIc(m);
      await submit(ic, m.job.id, pdf(`${title}.pdf`));
      const plan = await planOf(m.job.id);
      await run((tx) => reviewOpsPlan(reviewer, tx, plan.id, { decision: "agreed", comments: "" }));
      return { ...m, ic, plan };
    }

    test("lists agreed plans of past jobs for personnel, coordinators and admins; filters by text and year; vendors refused", async () => {
      const { db } = get();
      const [other] = await db.insert(vendors).values({ name: "Harbor Festival Committee", defaultRateCents: 7000 }).returning();
      const a = await agreedPast("Library parade", undefined, agencyInstant(2020, 4, 4, 9, 0));
      const b = await agreedPast("Library regatta", other.id, agencyInstant(2021, 5, 5, 9, 0));
      // not listed: pending review, denied-only, and a future job
      const pending = await mkOpsJob({ startAt: agencyInstant(2020, 6, 6, 9, 0), title: "Library pending" });
      await submit((await mkIc(pending)).ic, pending.job.id);
      const denied = await mkOpsJob({ startAt: agencyInstant(2020, 7, 7, 9, 0), title: "Library denied" });
      await submit((await mkIc(denied)).ic, denied.job.id);
      const deniedPlan = await planOf(denied.job.id);
      await run((tx) => reviewOpsPlan(reviewer, tx, deniedPlan.id, { decision: "denied", comments: "No." }));
      const future = await mkOpsJob({ title: "Library future" });
      await submit((await mkIc(future)).ic, future.job.id);
      const futurePlan = await planOf(future.job.id);
      await run((tx) => reviewOpsPlan(reviewer, tx, futurePlan.id, { decision: "agreed", comments: "" }));

      const person = await fx.person();
      const all = await run((tx) => searchLibrary(person, tx, {}, 1));
      const titles = all.map((r) => r.jobTitle).filter((t) => t.startsWith("Library"));
      expect(titles).toEqual(["Library regatta", "Library parade"]);
      const row = all.find((r) => r.jobTitle === "Library parade")!;
      expect(row).toMatchObject({ jobId: a.job.id, vendorName: "ops Vendor", year: 2020, icName: expect.stringContaining("ops"), filename: "Library parade.pdf" });
      expect(row.startAt).toEqual(a.job.startAt);
      expect(await run((tx) => searchLibrary(fx.coord, tx, {}, 1))).toHaveLength(all.length);
      expect(await run((tx) => searchLibrary(admin, tx, {}, 1))).toHaveLength(all.length);
      expect((await run((tx) => searchLibrary(person, tx, { year: 2021 }, 1))).map((r) => r.jobTitle)).toEqual(["Library regatta"]);
      expect((await run((tx) => searchLibrary(person, tx, { text: "harbor" }, 1))).map((r) => r.jobTitle)).toEqual(["Library regatta"]);
      expect((await run((tx) => searchLibrary(person, tx, { text: "PARADE" }, 1))).map((r) => r.jobTitle)).toEqual(["Library parade"]);
      const vendorActor: Actor = { userId: "x", role: "vendor", rankId: null, vendorId: b.job.vendorId };
      await expect(run((tx) => searchLibrary(vendorActor, tx, {}, 1))).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("personnel, coordinators and admins download any version; vendors never", async () => {
      const a = await agreedPast("Library download");
      const [version] = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, a.plan.id));
      const person = await fx.person();
      for (const who of [person, fx.coord, admin]) {
        const f = await run((tx) => readOpsPlanVersion(who, tx, version.id, storage));
        expect(f.body.equals(PDF)).toBe(true);
        expect(f.row.filename).toBe("Library download.pdf");
      }
      const vendorActor: Actor = { userId: "x", role: "vendor", rankId: null, vendorId: a.job.vendorId };
      await expect(run((tx) => readOpsPlanVersion(vendorActor, tx, version.id, storage))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run((tx) => getJobOpsPlan(vendorActor, tx, a.job.id))).rejects.toBeInstanceOf(ForbiddenError);
    });

    test("personnel cannot read a version of a vendor request that is not approved, or was declined", async () => {
      const a = await agreedPast("Hidden request download");
      const [version] = await get().db.select().from(opsPlanVersions).where(eq(opsPlanVersions.opsPlanId, a.plan.id));
      const person = await fx.person();
      for (const state of ["requested", "declined"] as const) {
        await get().db.update(jobs).set({ state }).where(eq(jobs.id, a.job.id));
        await expect(run((tx) => readOpsPlanVersion(person, tx, version.id, storage))).rejects.toBeInstanceOf(NotFoundError);
        expect((await run((tx) => readOpsPlanVersion(fx.coord, tx, version.id, storage))).body.equals(PDF)).toBe(true);
      }
    });
  });
});
