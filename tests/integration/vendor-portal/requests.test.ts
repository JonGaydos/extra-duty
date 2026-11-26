import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import type { Tx } from "@/db/client";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import {
  assignments,
  auditLog,
  invoices,
  jobAttachments,
  jobChangeRequests,
  jobPositions,
  jobSafety,
  jobTypes,
  jobs,
  notifications,
  positionTypes,
  qualifications,
  users,
  vendorHolds,
  vendorLocations,
  vendorUsers,
  vendors,
} from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { signUp, joinBackup } from "@/domain/assignments/signup";
import { billAssignment } from "@/domain/billing/bill";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { cancelJob, createJob, getJob, listJobs, type JobInput } from "@/domain/jobs/jobs";
import { qualificationHolderCount } from "@/domain/jobs/qualifications";
import { resolveSafetyPins } from "@/domain/jobs/safety";
import { deriveJobStatus } from "@/domain/jobs/status";
import { updateSettings } from "@/domain/settings/settings";
import {
  approveJobChange,
  approveRequest,
  declineJobChange,
  declineRequest,
  isJobLocked,
  lockedDetailsForTodo,
  submitRequest,
  vendorCancelJob,
  vendorEditJob,
  vendorViewJob,
  waiveLateCancelPay,
  type VendorRequestInput,
} from "@/domain/vendor-portal/requests";
import { placePaymentHold, resolvePaymentHold } from "@/domain/vendors/vendors";
import { agencyDayKey, agencyInstant } from "@/domain/time/agency-time";
import { resetGeocoder } from "@/domain/vendors/geocode";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

// Fake fetches are async to match fetch; they answer at once.

const HOUR = 3_600_000;
const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
const nominatim = () => new Response(JSON.stringify([{ lat: "30.5", lon: "-86.1" }]), { status: 200 });

describe("vendor portal", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let vendorUser: Actor;
  let vendorUserId: string;
  let otherVendorUser: Actor;
  let typeId: string;
  let sheriffPos: string;

  const run = <T>(fn: (tx: Tx) => Promise<T>) => get().db.transaction(fn);

  const setSettings = (patch: Parameters<typeof updateSettings>[2]) => get().db.transaction((tx) => updateSettings(admin, tx, patch));
  const inHours = (h: number) => new Date(Date.now() + h * HOUR);

  const baseInput = (over: Partial<VendorRequestInput> = {}): VendorRequestInput => ({
    typeId,
    title: "Church service",
    description: "Sunday traffic",
    startAt: inHours(100),
    endAt: inHours(104),
    ...over,
  });

  /** A released job for the fixture vendor starting `h` hours from now, created directly by a coordinator. */
  async function mkJob(h: number, o: { vendorId?: string; count?: number; lengthHours?: number } = {}) {
    const input: JobInput = {
      vendorId: o.vendorId ?? fx.vendorId,
      locationId: null,
      typeId,
      title: "Stadium security",
      description: null,
      notes: null,
      startAt: inHours(h),
      endAt: inHours(h + (o.lengthHours ?? 6)),
      rateCents: null,
      positions: [{ positionTypeId: sheriffPos, count: o.count ?? 2 }],
      opsPlanRequired: false,
      opsPlanDueAt: null,
      contactName: null,
      contactPhone: null,
      held: false,
      flex: null,
    };
    const job = await run((tx) => createJob(fx.coord, tx, input));
    await get().db.update(jobs).set({ state: "active", releaseAt: new Date("2000-01-01") }).where(eq(jobs.id, job.id));
    const [position] = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
    return { job, positionId: position.id };
  }

  async function mkPerson(address = true) {
    const p = await fx.person();
    if (address) await get().db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, p.userId));
    return p;
  }

  async function signedUp(h: number, n = 2, o: { count?: number } = {}) {
    const { job, positionId } = await mkJob(h, { count: o.count ?? n });
    const people: Actor[] = [];
    for (let i = 0; i < n; i++) {
      const p = await mkPerson();
      await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" });
      people.push(p);
    }
    return { job, positionId, people };
  }

  const alertsOf = async (userId: string, type: string) =>
    get().db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type as never)));
  const assignmentRows = (jobId: string) => get().db.select().from(assignments).where(eq(assignments.jobId, jobId));
  const jobRow = async (id: string) => (await get().db.select().from(jobs).where(eq(jobs.id, id)))[0];
  const auditActions = async (id: string) => (await get().db.select().from(auditLog).where(eq(auditLog.entityId, id))).map((a) => a.action);

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-vendor-portal-"));
    setEmailSender(createMemorySender());
    fx = await setupFixture(db, "vp");
    admin = (await makeUser(db, "admin", "vp-admin@example.test")).actor;
    const made = await makeUser(db, "vendor", "vp-vendor@example.test");
    vendorUser = { ...made.actor, vendorId: fx.vendorId };
    vendorUserId = made.row.id;
    await db.insert(vendorUsers).values({ userId: made.row.id, vendorId: fx.vendorId });
    const other = await makeUser(db, "vendor", "vp-vendor-other@example.test");
    otherVendorUser = { ...other.actor, vendorId: fx.otherVendorId };
    await db.insert(vendorUsers).values({ userId: other.row.id, vendorId: fx.otherVendorId });
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(eq(vendors.id, fx.vendorId));
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    sheriffPos = fx.pos["Deputy Sheriff"];
    await setSettings({ defaultPositionTypeId: sheriffPos, agencyDefaultRateCents: 6500 });
  });

  beforeEach(async () => {
    resetGeocoder({ intervalMs: 0 });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(nominatim())));
    await setSettings({
      email: GOOD_EMAIL,
      billingReplyToEmail: "billing@sheriff.example",
      invoiceReviewMode: "immediate",
      minimumBillableMinutes: 240,
      hourRoundingMinutes: 15,
      lateCancelPayBasis: "minimum",
      lateVendorCancelHours: 24,
      vendorMinNoticeHours: 72,
      vendorEditLockHours: 24,
      vendorEditsAfterSignup: "none",
      vendorCancelUntilHours: 2,
      vendorCanSetRate: false,
      vendorSeesAssignedNames: true,
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  describe("requests", () => {
    test("a vendor request becomes one requested job, alerts coordinators and uses the vendor rate", async () => {
      const [job] = await run((tx) => submitRequest(vendorUser, tx, baseInput({ newLocation: { name: "Main Campus", address: "1 Church St" } })));
      expect(job.state).toBe("requested");
      expect(job.requestedByUserId).toBe(vendorUserId);
      expect(job.rateCents).toBe(7000);
      expect(job.vendorId).toBe(fx.vendorId);
      const [loc] = await get().db.select().from(vendorLocations).where(eq(vendorLocations.id, job.locationId!));
      expect(loc.vendorId).toBe(fx.vendorId);
      expect(loc.name).toBe("Main Campus");
      const detail = await run((tx) => getJob(fx.coord, tx, job.id));
      expect(detail.positions.map((p) => [p.positionTypeId, p.count])).toEqual([[sheriffPos, 1]]);
      expect(await alertsOf(fx.coord.userId, "vendor.request_submitted")).not.toHaveLength(0);
      expect(await auditActions(job.id)).toContain("job.create");
    });

    test("a vendor cannot set the rate unless the setting allows it", async () => {
      const [a] = await run((tx) => submitRequest(vendorUser, tx, baseInput({ rateCents: 9900 })));
      expect(a.rateCents).toBe(7000);
      await setSettings({ vendorCanSetRate: true });
      const [b] = await run((tx) => submitRequest(vendorUser, tx, baseInput({ rateCents: 9900 })));
      expect(b.rateCents).toBe(9900);
    });

    test("one of the vendor's own active locations, never another vendor's", async () => {
      const [mine] = await get().db.insert(vendorLocations).values({ vendorId: fx.vendorId, name: "Mine" }).returning();
      const [theirs] = await get().db.insert(vendorLocations).values({ vendorId: fx.otherVendorId, name: "Theirs" }).returning();
      const [ok] = await run((tx) => submitRequest(vendorUser, tx, baseInput({ locationId: mine.id })));
      expect(ok.locationId).toBe(mine.id);
      await expect(run((tx) => submitRequest(vendorUser, tx, baseInput({ locationId: theirs.id })))).rejects.toBeInstanceOf(ValidationError);
    });

    test("refused inside the minimum notice", async () => {
      await expect(run((tx) => submitRequest(vendorUser, tx, baseInput({ startAt: inHours(71), endAt: inHours(75) })))).rejects.toThrow(/72 hours/);
      await expect(run((tx) => submitRequest(vendorUser, tx, baseInput({ startAt: inHours(73), endAt: inHours(77) })))).resolves.toHaveLength(1);
    });

    test("coordinators submitting for a vendor bypass the minimum notice", async () => {
      const [job] = await run((tx) => submitRequest(fx.coord, tx, baseInput({ vendorId: fx.vendorId, startAt: inHours(10), endAt: inHours(14) })));
      expect(job.state).toBe("requested");
    });

    test("vendor request decisions default to email only", async () => {
      const { DEFAULT_CHANNELS } = await import("@/domain/notifications/types");
      expect(DEFAULT_CHANNELS["vendor.request_decided"]).toEqual({ email: true, push: false });
    });

    test("only vendor requestable position types are accepted; a coordinator can unmark one", async () => {
      const { db } = get();
      const types = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p]));
      expect(types["Incident Commander"].vendorRequestable).toBe(true);
      expect(types["Dispatcher"].vendorRequestable).toBe(true);
      const ic = types["Incident Commander"].id;
      await expect(run((tx) => submitRequest(vendorUser, tx, baseInput({ positions: [{ positionTypeId: ic, count: 1 }] })))).resolves.toHaveLength(1);
      await db.update(positionTypes).set({ vendorRequestable: false }).where(eq(positionTypes.id, ic));
      try {
        await expect(run((tx) => submitRequest(vendorUser, tx, baseInput({ positions: [{ positionTypeId: ic, count: 1 }] })))).rejects.toBeInstanceOf(ValidationError);
      } finally {
        await db.update(positionTypes).set({ vendorRequestable: true }).where(eq(positionTypes.id, ic));
      }
    });

    test("vendors cannot override eligible ranks or required flags", async () => {
      const [job] = await run((tx) =>
        submitRequest(vendorUser, tx, baseInput({ positions: [{ positionTypeId: sheriffPos, count: 2, eligibleRankIdsOverride: [fx.rank["Posse"]], requiredQualificationIdsOverride: [] }] })),
      );
      const [p] = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
      expect(p.count).toBe(2);
      expect(p.eligibleRankIdsOverride).toBeNull();
      expect(p.requiredQualificationIdsOverride).toBeNull();
    });

    test("a vendor request for another vendor is not found and personnel are forbidden", async () => {
      await expect(run((tx) => submitRequest(otherVendorUser, tx, baseInput({ vendorId: fx.vendorId })))).rejects.toBeInstanceOf(NotFoundError);
      const deputy = await mkPerson();
      await expect(run((tx) => submitRequest(deputy, tx, baseInput({ vendorId: fx.vendorId })))).rejects.toBeInstanceOf(ForbiddenError);
      const [viaCoord] = await run((tx) => submitRequest(fx.coord, tx, baseInput({ vendorId: fx.vendorId })));
      expect(viaCoord.state).toBe("requested");
    });

    test("a contract link or file and officer safety notes come with the request", async () => {
      const safety = await resolveSafetyPins({ notes: "Gate code 1234", addresses: [{ address: "9 Back Rd", description: "Rear entrance" }] });
      const [job] = await run((tx) =>
        submitRequest(vendorUser, tx, baseInput({ contract: { label: "Signed contract", url: "https://docs.example/c1" }, safety })),
      );
      const att = await get().db.select().from(jobAttachments).where(eq(jobAttachments.jobId, job.id));
      expect(att.map((a) => [a.label, a.url, a.isContract])).toEqual([["Signed contract", "https://docs.example/c1", true]]);
      const [s] = await get().db.select().from(jobSafety).where(eq(jobSafety.jobId, job.id));
      expect(s.addedBy).toBe(vendorUserId);
      await expect(run((tx) => submitRequest(vendorUser, tx, baseInput({ contract: { label: "Bad", url: "http://insecure.example" } })))).rejects.toBeInstanceOf(ValidationError);
    });

    test("a contract file is stored once and attached as the contract of every date", async () => {
      const pdf = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.from("contract ".repeat(20))]);
      const base = new Date(Date.now() + 130 * HOUR);
      const day = (n: number) => new Date(base.getTime() + n * 24 * HOUR).toISOString().slice(0, 10);
      const created = await run((tx) =>
        submitRequest(vendorUser, tx, baseInput({ dates: { kind: "dates", dates: [day(0), day(1)] }, contract: { label: "Event contract", file: { body: pdf, filename: "c.pdf", contentType: "application/pdf" } } })),
      );
      const att = await get().db.select().from(jobAttachments).where(inArray(jobAttachments.jobId, created.map((j) => j.id)));
      expect(att).toHaveLength(2);
      expect(new Set(att.map((a) => a.fileId)).size).toBe(1);
      expect(att.every((a) => a.isContract && a.fileId)).toBe(true);
    });

    test("dates create one requested job per date in one series and approval covers the whole set", async () => {
      const base = new Date(Date.now() + 120 * HOUR);
      const d = (n: number) => new Date(base.getTime() + n * 24 * HOUR).toISOString().slice(0, 10);
      const start = agencyInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 9, 0);
      const end = agencyInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 13, 0);
      const created = await run((tx) => submitRequest(vendorUser, tx, baseInput({ startAt: start, endAt: end, dates: { kind: "dates", dates: [d(0), d(7), d(14)] } })));
      expect(created).toHaveLength(3);
      expect(new Set(created.map((j) => j.seriesId)).size).toBe(1);
      expect(created.every((j) => j.state === "requested")).toBe(true);
      expect(await alertsOf(fx.coord.userId, "vendor.request_submitted")).not.toHaveLength(0);

      await expect(run((tx) => approveRequest(vendorUser, tx, created[1].id))).rejects.toBeInstanceOf(ForbiddenError);
      const approved = await run((tx) => approveRequest(fx.coord, tx, created[1].id, { title: "Church service (approved)" }));
      expect(approved).toHaveLength(3);
      for (const j of created) {
        const row = await jobRow(j.id);
        expect(row.state).toBe("scheduled");
        expect(row.title).toBe("Church service (approved)");
      }
      expect((await alertsOf(vendorUserId, "vendor.request_decided")).length).toBeGreaterThan(0);
      expect(await auditActions(created[0].id)).toContain("job.request_approve");
      await expect(run((tx) => approveRequest(fx.coord, tx, created[0].id))).rejects.toBeInstanceOf(ValidationError);
    });

    test("a per-date time change applies to that date only, and the notice rule checks it", async () => {
      const base = new Date(Date.now() + 120 * HOUR);
      const d = (n: number) => new Date(base.getTime() + n * 24 * HOUR).toISOString().slice(0, 10);
      const start = agencyInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 9, 0);
      const end = agencyInstant(base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(), 13, 0);
      const flex = { earliestStartAt: new Date(start.getTime() - HOUR), latestEndAt: new Date(end.getTime() + HOUR), allowShorter: true };
      const created = await run((tx) =>
        submitRequest(vendorUser, tx, baseInput({ startAt: start, endAt: end, flex, dates: { kind: "dates", dates: [d(0), d(1), d(2)] }, overrides: { [d(1)]: { startTime: "10:00", endTime: "15:00" } } })),
      );
      expect(created).toHaveLength(3);
      const hours = created.map((j) => [new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", hour: "numeric", hour12: false }).format(j.startAt), (j.endAt.getTime() - j.startAt.getTime()) / HOUR]);
      expect(hours).toEqual([["09", 4], ["10", 5], ["09", 4]]);
      expect(created.every((j) => j.flexAllowShorter)).toBe(true);

      // A changed time that falls inside the minimum notice is refused like any other date: the day 72 hours out
      // at 23:59 passes, the same day at midnight does not.
      const dayKey = agencyDayKey(new Date(Date.now() + 72 * HOUR));
      const [y, m, dd] = dayKey.split("-").map(Number);
      const late = agencyInstant(y, m, dd, 23, 59);
      const next = agencyDayKey(new Date(late.getTime() + 2 * HOUR));
      await expect(
        run((tx) => submitRequest(vendorUser, tx, baseInput({ startAt: late, endAt: new Date(late.getTime() + 3 * HOUR), dates: { kind: "dates", dates: [dayKey, next] }, overrides: { [dayKey]: { startTime: "00:00", endTime: "02:00" } } }))),
      ).rejects.toThrow(/at least 72 hours notice/);
    });

    test("decline needs a reason, closes the request and tells the vendor", async () => {
      const [job] = await run((tx) => submitRequest(vendorUser, tx, baseInput()));
      await expect(run((tx) => declineRequest(fx.coord, tx, job.id, " "))).rejects.toBeInstanceOf(ValidationError);
      await expect(run((tx) => declineRequest(vendorUser, tx, job.id, "no"))).rejects.toBeInstanceOf(ForbiddenError);
      const before = (await alertsOf(vendorUserId, "vendor.request_decided")).length;
      const declined = await run((tx) => declineRequest(fx.coord, tx, job.id, "Not enough deputies that day"));
      expect(declined[0].state).toBe("declined");
      expect((await jobRow(job.id)).cancelReason).toBe("Not enough deputies that day");
      const after = await alertsOf(vendorUserId, "vendor.request_decided");
      expect(after).toHaveLength(before + 1);
      expect(after.at(-1)!.body).toMatch(/Not enough deputies/);
    });
  });

  describe("edits", () => {
    test("a description edit applies at once and alerts the people on the job", async () => {
      const { job, positionId } = await mkJob(200, { count: 1 });
      const backup = await mkPerson();
      await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: backup.userId, status: "backup", backupPosition: 1 });
      const r = await run((tx) => vendorEditJob(vendorUser, tx, job.id, { description: "Park behind the hall" }));
      expect(r.applied).toBe(true);
      expect((await jobRow(job.id)).description).toBe("Park behind the hall");
      expect(await alertsOf(backup.userId, "job.changed")).toHaveLength(1);
    });

    test("a description edit is refused once someone is signed up when edits after sign-up are none", async () => {
      const { job } = await signedUp(200, 1);
      await expect(run((tx) => vendorEditJob(vendorUser, tx, job.id, { description: "x" }))).rejects.toBeInstanceOf(RuleViolation);
    });

    test("a same-total position swap counts as an increase and a decrease, not only more headcount", async () => {
      const { job } = await signedUp(200, 1, { count: 1 });
      await setSettings({ vendorEditsAfterSignup: "add_positions" });
      const dispatcher = fx.pos["Dispatcher"];
      await expect(run((tx) => vendorEditJob(vendorUser, tx, job.id, { positions: [{ positionTypeId: dispatcher, count: 1 }] }))).rejects.toBeInstanceOf(RuleViolation);
      const added = await run((tx) => vendorEditJob(vendorUser, tx, job.id, { positions: [{ positionTypeId: sheriffPos, count: 1 }, { positionTypeId: dispatcher, count: 1 }] }));
      expect(added.applied).toBe(false);
    });

    test("a still-requested job cannot be moved inside the minimum notice or edit lock by a vendor", async () => {
      const [job] = await run((tx) => submitRequest(vendorUser, tx, baseInput()));
      await expect(run((tx) => vendorEditJob(vendorUser, tx, job.id, { startAt: inHours(2), endAt: inHours(6) }))).rejects.toThrow();
      expect((await jobRow(job.id)).startAt.getTime()).toBe(job.startAt.getTime());
      const coordMove = await run((tx) => vendorEditJob(fx.coord, tx, job.id, { startAt: inHours(2), endAt: inHours(6) }));
      expect(coordMove.applied).toBe(true);
      await setSettings({ vendorEditLockHours: 500 });
      const [other] = await run((tx) => submitRequest(vendorUser, tx, baseInput()));
      await expect(run((tx) => vendorEditJob(vendorUser, tx, other.id, { description: "x" }))).rejects.toBeInstanceOf(RuleViolation);
    });

    test("a time change creates a pending change that a coordinator approves and signed-up people hear about", async () => {
      const { job } = await mkJob(200, { count: 1 });
      const newStart = inHours(201);
      const newEnd = inHours(207);
      const r = await run((tx) => vendorEditJob(vendorUser, tx, job.id, { startAt: newStart, endAt: newEnd }));
      expect(r.applied).toBe(false);
      expect((await jobRow(job.id)).startAt.getTime()).toBe(job.startAt.getTime());
      const [pending] = await get().db.select().from(jobChangeRequests).where(eq(jobChangeRequests.jobId, job.id));
      expect(pending.status).toBe("pending");
      expect(pending.requestedBy).toBe(vendorUserId);
      expect(await alertsOf(fx.coord.userId, "vendor.request_edited")).not.toHaveLength(0);

      const person = await mkPerson();
      const [pos] = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
      await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: pos.id, userId: person.userId, status: "backup", backupPosition: 1 });
      await expect(run((tx) => approveJobChange(vendorUser, tx, pending.id))).rejects.toBeInstanceOf(ForbiddenError);
      await run((tx) => approveJobChange(fx.coord, tx, pending.id));
      const row = await jobRow(job.id);
      expect(row.startAt.getTime()).toBe(newStart.getTime());
      const [done] = await get().db.select().from(jobChangeRequests).where(eq(jobChangeRequests.id, pending.id));
      expect(done.status).toBe("approved");
      expect(done.decidedBy).toBe(fx.coord.userId);
      expect(await alertsOf(person.userId, "job.changed")).toHaveLength(1);
      await expect(run((tx) => approveJobChange(fx.coord, tx, pending.id))).rejects.toBeInstanceOf(ValidationError);
    });

    test("declining a pending change keeps the job as it was", async () => {
      const { job } = await mkJob(200, { count: 1 });
      const r = await run((tx) => vendorEditJob(vendorUser, tx, job.id, { positions: [{ positionTypeId: sheriffPos, count: 3 }] }));
      expect(r.applied).toBe(false);
      const pendingId = (r as { applied: false; request: { id: string } }).request.id;
      await expect(run((tx) => declineJobChange(fx.coord, tx, pendingId, ""))).rejects.toBeInstanceOf(ValidationError);
      await run((tx) => declineJobChange(fx.coord, tx, pendingId, "Cannot staff three"));
      const [row] = await get().db.select().from(jobChangeRequests).where(eq(jobChangeRequests.id, pendingId));
      expect(row.status).toBe("declined");
      expect(row.reason).toBe("Cannot staff three");
      const [p] = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
      expect(p.count).toBe(1);
      expect((await alertsOf(vendorUserId, "vendor.request_decided")).at(-1)!.body).toMatch(/Cannot staff three/);
    });

    test("changes inside the lock window are refused", async () => {
      const { job } = await mkJob(20);
      await expect(run((tx) => vendorEditJob(vendorUser, tx, job.id, { description: "late" }))).rejects.toBeInstanceOf(RuleViolation);
    });

    test("headcount down is refused once someone is signed up", async () => {
      const { job } = await signedUp(200, 1, { count: 2 });
      await expect(run((tx) => vendorEditJob(vendorUser, tx, job.id, { positions: [{ positionTypeId: sheriffPos, count: 1 }] }))).rejects.toBeInstanceOf(RuleViolation);
      expect(await get().db.select().from(jobChangeRequests).where(eq(jobChangeRequests.jobId, job.id))).toHaveLength(0);
    });

    test("a vendor cannot edit another vendor's job and cannot pick unrequestable position types", async () => {
      const { job } = await mkJob(200);
      await expect(run((tx) => vendorEditJob(otherVendorUser, tx, job.id, { description: "x" }))).rejects.toBeInstanceOf(NotFoundError);
      const deputy = await mkPerson();
      await expect(run((tx) => vendorEditJob(deputy, tx, job.id, { description: "x" }))).rejects.toBeInstanceOf(ForbiddenError);
      const { db } = get();
      await db.update(positionTypes).set({ vendorRequestable: false }).where(eq(positionTypes.id, sheriffPos));
      try {
        await expect(run((tx) => vendorEditJob(vendorUser, tx, job.id, { positions: [{ positionTypeId: sheriffPos, count: 3 }] }))).rejects.toBeInstanceOf(ValidationError);
      } finally {
        await db.update(positionTypes).set({ vendorRequestable: true }).where(eq(positionTypes.id, sheriffPos));
      }
    });

    test("editing a request that is still waiting applies directly and alerts coordinators", async () => {
      const [job] = await run((tx) => submitRequest(vendorUser, tx, baseInput()));
      const before = (await alertsOf(fx.coord.userId, "vendor.request_edited")).length;
      const r = await run((tx) => vendorEditJob(vendorUser, tx, job.id, { startAt: inHours(130), endAt: inHours(134) }));
      expect(r.applied).toBe(true);
      expect((await jobRow(job.id)).state).toBe("requested");
      expect(await alertsOf(fx.coord.userId, "vendor.request_edited")).toHaveLength(before + 1);
    });
  });

  describe("cancellation and late cancellation pay", () => {
    // Nothing is billable before the detail's scheduled end, late-cancel pay included: bill just after it.
    const bill = (actor: Actor, assignmentId: string, job: { startAt: Date; endAt: Date }) =>
      get().db.transaction((tx) => billAssignment(actor, tx, assignmentId, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, new Date(job.endAt.getTime() + 1000)));

    test("a vendor cancel 23 hours before start makes signed-up deputies late_canceled and billable", async () => {
      const { job, people } = await signedUp(23);
      const canceled = await run((tx) => vendorCancelJob(vendorUser, tx, job.id, "Event rained out"));
      expect(canceled.state).toBe("canceled");
      expect(canceled.canceledByVendor).toBe(true);
      const rows = await assignmentRows(job.id);
      expect(rows.map((r) => r.status)).toEqual(["late_canceled", "late_canceled"]);
      for (const p of people) {
        const alert = (await alertsOf(p.userId, "job.canceled"))[0];
        expect(alert.body).toMatch(/late cancellation/i);
      }
      const a = rows.find((r) => r.userId === people[0].userId)!;
      const r = await bill(people[0], a.id, job);
      expect(r.invoice.kind).toBe("late_cancel");
      expect(r.invoice.minutes).toBe(240);
      expect(r.invoice.totalCents).toBe(28000);
      expect(r.invoice.responsibleParty).toBe("vendor");
    });

    test("a vendor cancel 25 hours before start creates nothing billable", async () => {
      await setSettings({ vendorCancelUntilHours: 2 });
      const { job, people } = await signedUp(25);
      await run((tx) => vendorCancelJob(vendorUser, tx, job.id, "Changed plans"));
      const rows = await assignmentRows(job.id);
      expect(rows.map((r) => r.status)).toEqual(["canceled", "canceled"]);
      expect(rows.every((r) => r.removalReason === "Changed plans")).toBe(true);
      expect(await auditActions(rows[0].id)).toContain("assignment.job_canceled");
      const alert = (await alertsOf(rows[0].userId, "job.canceled"))[0];
      expect(alert.body).not.toMatch(/late cancellation/i);
      const person = people.find((p) => p.userId === rows[0].userId)!;
      await expect(bill(person, rows[0].id, job)).rejects.toBeInstanceOf(RuleViolation);
      expect(await get().db.select().from(invoices).where(eq(invoices.assignmentId, rows[0].id))).toHaveLength(0);
    });

    test("the late window follows lateVendorCancelHours and the pay basis follows lateCancelPayBasis", async () => {
      await setSettings({ lateVendorCancelHours: 48, lateCancelPayBasis: "scheduled" });
      const { job, people } = await signedUp(40);
      await run((tx) => vendorCancelJob(vendorUser, tx, job.id, "Weather"));
      const a = (await assignmentRows(job.id)).find((r) => r.userId === people[0].userId)!;
      expect(a.status).toBe("late_canceled");
      const r = await bill(people[0], a.id, job);
      expect(r.invoice.minutes).toBe(360);
    });

    test("vendors cannot cancel inside vendorCancelUntilHours, at or after start, or for another vendor", async () => {
      const soon = await signedUp(1, 1);
      await expect(run((tx) => vendorCancelJob(vendorUser, tx, soon.job.id, "late"))).rejects.toBeInstanceOf(RuleViolation);
      const started = await mkJob(-1);
      await expect(run((tx) => vendorCancelJob(vendorUser, tx, started.job.id, "too late"))).rejects.toBeInstanceOf(RuleViolation);
      await expect(run((tx) => vendorCancelJob(fx.coord, tx, started.job.id, "too late"))).rejects.toBeInstanceOf(ValidationError);
      const far = await mkJob(100);
      await expect(run((tx) => vendorCancelJob(otherVendorUser, tx, far.job.id, "x"))).rejects.toBeInstanceOf(NotFoundError);
      await expect(run((tx) => vendorCancelJob(vendorUser, tx, far.job.id, " "))).rejects.toBeInstanceOf(ValidationError);
    });

    test("a coordinator may cancel for the vendor right up to the start", async () => {
      const { job } = await signedUp(1, 1);
      const canceled = await run((tx) => vendorCancelJob(fx.coord, tx, job.id, "Vendor phoned"));
      expect(canceled.canceledByVendor).toBe(true);
      expect((await assignmentRows(job.id))[0].status).toBe("late_canceled");
    });

    test("an unapproved request canceled by its vendor is simply canceled", async () => {
      const [job] = await run((tx) => submitRequest(vendorUser, tx, baseInput()));
      const canceled = await run((tx) => vendorCancelJob(vendorUser, tx, job.id, "Never mind"));
      expect(canceled.state).toBe("canceled");
    });

    test("waive: a coordinator with a reason waives unbilled pay and alerts both deputies", async () => {
      const { job, people } = await signedUp(10);
      await run((tx) => vendorCancelJob(fx.coord, tx, job.id, "Vendor phoned"));
      const waived = await run((tx) => waiveLateCancelPay(fx.coord, tx, job.id, "Vendor paid directly"));
      expect(waived).toHaveLength(2);
      for (const p of people) expect(await alertsOf(p.userId, "job.late_cancel_waived")).toHaveLength(1);
      expect((await assignmentRows(job.id)).map((r) => r.status)).toEqual(["canceled", "canceled"]);
    });

    test("waive: personnel are refused; only unbilled pay is waived and the billed deputy is not alerted", async () => {
      const { job, people } = await signedUp(10);
      await run((tx) => vendorCancelJob(fx.coord, tx, job.id, "Vendor phoned"));
      const rows = await assignmentRows(job.id);
      const billedRow = rows.find((r) => r.userId === people[0].userId)!;
      await bill(people[0], billedRow.id, job);
      await expect(run((tx) => waiveLateCancelPay(people[1], tx, job.id, "please"))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run((tx) => waiveLateCancelPay(vendorUser, tx, job.id, "please"))).rejects.toBeInstanceOf(ForbiddenError);
      await expect(run((tx) => waiveLateCancelPay(fx.coord, tx, job.id, " "))).rejects.toBeInstanceOf(ValidationError);
      const waived = await run((tx) => waiveLateCancelPay(fx.coord, tx, job.id, "Vendor paid the agency directly"));
      expect(waived).toHaveLength(1);
      const after = await assignmentRows(job.id);
      expect(after.find((r) => r.userId === people[1].userId)!.status).toBe("canceled");
      expect(after.find((r) => r.userId === people[0].userId)!.status).toBe("billed");
      expect((await jobRow(job.id)).lateCancelWaivedReason).toBe("Vendor paid the agency directly");
      expect(await alertsOf(people[1].userId, "job.late_cancel_waived")).toHaveLength(1);
      expect(await alertsOf(people[0].userId, "job.late_cancel_waived")).toHaveLength(0);
      expect(await auditActions(waived[0].id)).toContain("assignment.late_cancel_waive");
    });

    test("waive works for admins and fails on a job that was not canceled", async () => {
      const { job } = await signedUp(100, 1);
      await expect(run((tx) => waiveLateCancelPay(admin, tx, job.id, "reason"))).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("vendor view", () => {
    test("another vendor's job is not found, names show once filled, never contact details", async () => {
      const { job, people } = await signedUp(200, 2);
      await expect(run((tx) => vendorViewJob(otherVendorUser, tx, job.id))).rejects.toBeInstanceOf(NotFoundError);
      await expect(run((tx) => vendorViewJob(people[0], tx, job.id))).rejects.toBeInstanceOf(ForbiddenError);
      const view = await run((tx) => vendorViewJob(vendorUser, tx, job.id));
      expect(view.positions[0].assigned).toHaveLength(2);
      expect(view.positions[0].assigned![0].plannedStartAt).toBeInstanceOf(Date);
      const json = JSON.stringify(view);
      expect(json).not.toMatch(/@example\.test/);
      expect(json).not.toMatch(/phone|email|mailing|qualif|flag/i);
    });

    test("names are hidden until the detail is filled and when the setting is off", async () => {
      const partial = await signedUp(200, 1, { count: 2 });
      const v1 = await run((tx) => vendorViewJob(vendorUser, tx, partial.job.id));
      expect(v1.positions[0].filled).toBe(1);
      expect(v1.positions[0].assigned).toBeNull();
      const full = await signedUp(200, 2);
      await setSettings({ vendorSeesAssignedNames: false });
      const v2 = await run((tx) => vendorViewJob(vendorUser, tx, full.job.id));
      expect(v2.positions[0].assigned).toBeNull();
      expect(v2.positions[0].filled).toBe(2);
    });

    test("a coordinator can open the vendor view for any vendor", async () => {
      const { job } = await signedUp(200, 1, { count: 1 });
      const view = await run((tx) => vendorViewJob(fx.coord, tx, job.id));
      expect(view.positions[0].assigned).toHaveLength(1);
    });
  });

  test("qualificationHolderCount is for coordinators only", async () => {
    const [q] = await get().db.select().from(qualifications).limit(1);
    await expect(run((tx) => qualificationHolderCount(vendorUser, tx, q.id))).rejects.toBeInstanceOf(ForbiddenError);
    expect(await run((tx) => qualificationHolderCount(fx.coord, tx, q.id))).toBeGreaterThanOrEqual(0);
  });

  describe("payment hold", () => {
    // Every test here uses its own vendor so a hold never leaks into another test.
    async function holdVendor() {
      const { db } = get();
      const [v] = await db.insert(vendors).values({ name: `Hold ${Math.random()}`, defaultRateCents: 7000, billingEmails: ["ap@vendor.example"] }).returning();
      const made = await makeUser(db, "vendor", `hold-${v.id}@example.test`);
      await db.insert(vendorUsers).values({ userId: made.row.id, vendorId: v.id });
      return { vendorId: v.id, user: { ...made.actor, vendorId: v.id } as Actor, userId: made.row.id };
    }
    async function jobFor(vendorId: string, h: number, n = 1, count = 2) {
      const { job, positionId } = await mkJob(h, { vendorId, count });
      const people: Actor[] = [];
      for (let i = 0; i < n; i++) {
        const p = await mkPerson();
        await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status: "signed_up" });
        people.push(p);
      }
      return { job, positionId, people };
    }
    const place = (vendorId: string) => run((tx) => placePaymentHold(fx.coord, tx, vendorId, "Unpaid invoices"));

    test("placing a hold locks future jobs: no sign-ups or backups, hidden from open lists, existing sign-ups kept and alerted", async () => {
      const v = await holdVendor();
      const { job, positionId, people } = await jobFor(v.vendorId, 200);
      const outsider = await mkPerson();
      expect(await run((tx) => isJobLocked(tx, job.id))).toBe(false);
      await place(v.vendorId);
      expect(await run((tx) => isJobLocked(tx, job.id))).toBe(true);

      const holdMessages = async (p: Promise<unknown>) => {
        const e = await p.then(() => null, (err: unknown) => err);
        return e instanceof RuleViolation ? e.checks.filter((c) => !c.ok).map((c) => c.message) : [];
      };
      expect(await holdMessages(run((tx) => signUp(outsider, tx, positionId, { warningVersion: 1 })))).toContain("Vendor on payment hold");
      expect(await holdMessages(run((tx) => joinBackup(outsider, tx, positionId, { warningVersion: 1 })))).toContain("Vendor on payment hold");

      const window = { from: inHours(100), to: inHours(300) };
      const outsiderList = await run((tx) => listJobs(outsider, tx, window, 1));
      expect(outsiderList.map((j) => j.id)).not.toContain(job.id);
      const signedList = await run((tx) => listJobs(people[0], tx, window, 1));
      expect(signedList.map((j) => j.id)).toContain(job.id);
      const staffList = await run((tx) => listJobs(fx.coord, tx, window, 1));
      expect(staffList.map((j) => j.id)).toContain(job.id);

      expect((await assignmentRows(job.id)).filter((a) => a.status === "signed_up").length).toBeGreaterThanOrEqual(1);
      expect(await alertsOf(people[0].userId, "job.locked")).toHaveLength(1);
      expect(await alertsOf(outsider.userId, "job.locked")).toHaveLength(0);
      expect(
        deriveJobStatus(
          { state: "active", held: false, releaseAt: new Date(0), startAt: job.startAt, endAt: job.endAt, vendorOnPaymentHold: true, spots: 2 },
          [],
          [],
          new Date(),
        ),
      ).toBe("on_hold");
    });

    test("a vendor on hold cannot submit, edit or open details", async () => {
      const v = await holdVendor();
      const { job } = await jobFor(v.vendorId, 200);
      await place(v.vendorId);
      await expect(run((tx) => submitRequest(v.user, tx, baseInput()))).rejects.toThrow(/Vendor on payment hold/);
      await expect(run((tx) => vendorEditJob(v.user, tx, job.id, { description: "x" }))).rejects.toThrow(/Vendor on payment hold/);
      await expect(run((tx) => vendorViewJob(v.user, tx, job.id))).rejects.toThrow(/Vendor on payment hold/);
      await expect(run((tx) => vendorViewJob(fx.coord, tx, job.id))).resolves.toBeTruthy();
    });

    test("billing is closed for a worked locked detail, and reopens after the hold is resolved", async () => {
      const v = await holdVendor();
      const { job, people } = await jobFor(v.vendorId, 100, 1);
      const [a] = await assignmentRows(job.id);
      await place(v.vendorId);
      const after = new Date(job.endAt.getTime() + HOUR);
      await expect(
        get().db.transaction((tx) => billAssignment(people[0], tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, after)),
      ).rejects.toThrow(/locked while the vendor is on payment hold/);
      expect(await get().db.select().from(invoices).where(eq(invoices.assignmentId, a.id))).toHaveLength(0);
      await run((tx) => resolvePaymentHold(fx.coord, tx, v.vendorId, { outcome: "handled" }));
      const r = await get().db.transaction((tx) => billAssignment(people[0], tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, after));
      expect(r.invoice.kind).toBe("detail");
    });

    test("resolving with fix_coming unlocks, alerts the same people and reopens sign-ups", async () => {
      const v = await holdVendor();
      const { job, positionId, people } = await jobFor(v.vendorId, 200, 1);
      const outsider = await mkPerson();
      await place(v.vendorId);
      await run((tx) => resolvePaymentHold(fx.coord, tx, v.vendorId, { outcome: "fix_coming", note: "Check in the mail" }));
      expect(await run((tx) => isJobLocked(tx, job.id))).toBe(false);
      expect(await alertsOf(people[0].userId, "job.unlocked")).toHaveLength(1);
      const [hold] = await get().db.select().from(vendorHolds).where(eq(vendorHolds.vendorId, v.vendorId));
      expect(hold.outcome).toBe("fix_coming");
      const a = await run((tx) => signUp(outsider, tx, positionId, { warningVersion: 1 }));
      expect(a.status).toBe("signed_up");
      const staffList = await run((tx) => listJobs(outsider, tx, { from: inHours(100), to: inHours(300) }, 1));
      expect(staffList.map((j) => j.id)).toContain(job.id);
    });

    test("a detail that ended before the hold is not locked, bills and is off the to-do list; a future one is locked", async () => {
      const v = await holdVendor();
      const past = await jobFor(v.vendorId, -10, 1);
      const future = await jobFor(v.vendorId, 100, 1);
      await place(v.vendorId);
      expect(await run((tx) => isJobLocked(tx, past.job.id))).toBe(false);
      expect(await run((tx) => isJobLocked(tx, future.job.id))).toBe(true);
      const todo = await run((tx) => lockedDetailsForTodo(tx, new Date()));
      expect([...todo.started, ...todo.startingSoon].map((j) => j.id)).not.toContain(past.job.id);
      const [a] = await assignmentRows(past.job.id);
      const r = await get().db.transaction((tx) => billAssignment(past.people[0], tx, a.id, { startAt: past.job.startAt, endAt: past.job.endAt, attachW9: false }));
      expect(r.invoice.kind).toBe("detail");
    });

    test("a detail that was future at hold time and has since started is on the started list", async () => {
      const v = await holdVendor();
      const soon = await jobFor(v.vendorId, 2, 1);
      await place(v.vendorId);
      const todo = await run((tx) => lockedDetailsForTodo(tx, new Date(soon.job.startAt.getTime() + HOUR)));
      expect(todo.started.filter((j) => j.vendorId === v.vendorId).map((j) => j.id)).toEqual([soon.job.id]);
      expect(todo.startingSoon.filter((j) => j.vendorId === v.vendorId)).toEqual([]);
    });

    test("lockedDetailsForTodo lists started and soon-starting locked details and changes nothing", async () => {
      const v = await holdVendor();
      const started = await jobFor(v.vendorId, 2, 1);
      const soon = await jobFor(v.vendorId, 10, 1);
      const later = await jobFor(v.vendorId, 100, 1);
      await jobFor(fx.vendorId, -2, 1);
      await place(v.vendorId);
      const snapshot = async () => JSON.stringify([await get().db.select().from(jobs).where(inArray(jobs.id, [started.job.id, soon.job.id, later.job.id])), await get().db.select().from(assignments).where(inArray(assignments.jobId, [started.job.id, soon.job.id, later.job.id]))]);
      const before = await snapshot();
      const todo = await run((tx) => lockedDetailsForTodo(tx, new Date(started.job.startAt.getTime() + HOUR)));
      const mine = (list: typeof todo.started) => list.filter((j) => j.vendorId === v.vendorId).map((j) => j.id);
      expect(mine(todo.started)).toEqual([started.job.id]);
      expect(mine(todo.startingSoon)).toEqual([soon.job.id]);
      expect(todo.started[0].vendorName).toMatch(/^Hold /);
      expect(await snapshot()).toBe(before);
    });

    test("cancel with cause vendor_hold: hold placed 10 hours before start creates late cancellation invoices", async () => {
      const v = await holdVendor();
      const { job, people } = await jobFor(v.vendorId, 10, 2);
      await place(v.vendorId);
      const canceled = await run((tx) => cancelJob(fx.coord, tx, job.id, "Vendor on payment hold", { cause: "vendor_hold" }));
      expect(canceled.state).toBe("canceled");
      expect(canceled.canceledByVendor).toBe(false);
      const rows = await assignmentRows(job.id);
      expect(rows.map((r) => r.status)).toEqual(["late_canceled", "late_canceled"]);
      for (const p of people) {
        const row = rows.find((r) => r.userId === p.userId)!;
        const r = await get().db.transaction((tx) => billAssignment(p, tx, row.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, new Date(job.endAt.getTime() + 1000)));
        expect(r.invoice.kind).toBe("late_cancel");
        expect(r.invoice.minutes).toBe(240);
        expect(r.invoice.responsibleParty).toBe("vendor");
      }
    });

    test("cancel with cause vendor_hold: hold placed 30 hours before start creates nothing unless pay is applied", async () => {
      const v = await holdVendor();
      const first = await jobFor(v.vendorId, 30, 2);
      const second = await jobFor(v.vendorId, 30, 2);
      await place(v.vendorId);
      await run((tx) => cancelJob(fx.coord, tx, first.job.id, "Vendor on payment hold", { cause: "vendor_hold" }));
      const early = await assignmentRows(first.job.id);
      expect(early.map((r) => r.status)).toEqual(["canceled", "canceled"]);
      const person = first.people.find((p) => p.userId === early[0].userId)!;
      await expect(
        get().db.transaction((tx) => billAssignment(person, tx, early[0].id, { startAt: first.job.startAt, endAt: first.job.endAt, attachW9: false }, new Date(first.job.endAt.getTime() + HOUR))),
      ).rejects.toBeInstanceOf(RuleViolation);
      await run((tx) => cancelJob(fx.coord, tx, second.job.id, "Vendor on payment hold", { cause: "vendor_hold", applyLateCancelPay: true }));
      expect((await assignmentRows(second.job.id)).map((r) => r.status)).toEqual(["late_canceled", "late_canceled"]);
    });

    test("vendor_hold cancel needs the explicit cause and a locked job; the reason text alone is only a reason", async () => {
      const { job } = await signedUp(10, 1);
      await expect(run((tx) => cancelJob(fx.coord, tx, job.id, "Vendor on payment hold", { cause: "vendor_hold" }))).rejects.toBeInstanceOf(ValidationError);
      await run((tx) => cancelJob(fx.coord, tx, job.id, "vendor_hold"));
      expect((await assignmentRows(job.id))[0].status).toBe("canceled");
    });
  });
});
