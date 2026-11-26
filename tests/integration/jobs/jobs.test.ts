import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import {
  assignments,
  auditLog,
  jobAttachments,
  jobPositions,
  jobs,
  jobSafetyAddresses,
  jobTypes,
  notifications,
  positionTypes,
  ranks,
  vendorDocuments,
  vendors,
} from "@/db/schema";
import { seed } from "@/db/seed";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { detailsMissingContract, jobContractStatus } from "@/domain/jobs/contract-status";
import { cancelJob, createJob, getJob, listJobs, releaseHold, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { releaseAt } from "@/domain/release/release";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { resetGeocoder } from "@/domain/vendors/geocode";
import { byNumber, byText } from "@/lib/sort";

// Fake fetches are async to match fetch; they answer at once.

const nominatim = (lat: string, lon: string) => new Response(JSON.stringify([{ lat, lon }]), { status: 200 });

describe("jobs", () => {
  const get = useTestDb();
  useEmailQueue(get);
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) =>
    get().db.transaction(fn);
  let coord: Actor;
  let admin: Actor;
  let deputy: Actor;
  let vendorUser: Actor;
  let otherVendorUser: Actor;
  let vendorId: string;
  let otherVendorId: string;
  let typeId: string;
  let pos: Record<string, string>;
  let rank: Record<string, string>;
  let fetchMock: ReturnType<typeof vi.fn>;

  const start = agencyInstant(2035, 6, 10, 17, 0);
  const end = agencyInstant(2035, 6, 10, 23, 0);
  const base = (over: Partial<JobInput> = {}): JobInput => ({
    vendorId,
    locationId: null,
    typeId,
    title: "Stadium security",
    description: null,
    notes: null,
    startAt: start,
    endAt: end,
    rateCents: null,
    positions: [],
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: null,
    contactPhone: null,
    held: false,
    ...over,
  });
  const make = (over: Partial<JobInput> = {}) => run((tx) => createJob(coord, tx, base(over)));
  const addSignup = async (jobId: string, userId: string) => {
    const { db } = get();
    const [p] = await db.select().from(jobPositions).where(eq(jobPositions.jobId, jobId));
    await db.insert(assignments).values({ jobId, jobPositionId: p.id, userId, status: "signed_up" });
  };
  const auditActions = async (id: string) =>
    (await get().db.select().from(auditLog).where(eq(auditLog.entityId, id))).map((a) => a.action);

  beforeAll(async () => {
    const { db } = get();
    await seed(db);
    coord = (await makeUser(db, "coordinator", "jcoord@example.test")).actor;
    admin = (await makeUser(db, "admin", "jadmin@example.test")).actor;
    deputy = (await makeUser(db, "personnel", "jdeputy@example.test")).actor;
    const [v] = await db.insert(vendors).values({ name: "Alpha", defaultRateCents: 7000 }).returning();
    const [v2] = await db.insert(vendors).values({ name: "Beta" }).returning();
    vendorId = v.id;
    otherVendorId = v2.id;
    vendorUser = (await makeUser(db, "vendor", "jv1@example.test")).actor;
    vendorUser.vendorId = vendorId;
    otherVendorUser = (await makeUser(db, "vendor", "jv2@example.test")).actor;
    otherVendorUser.vendorId = otherVendorId;
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    pos = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
    rank = Object.fromEntries((await db.select().from(ranks)).map((r) => [r.name, r.id]));
    await run((tx) => updateSettings(coord, tx, { agencyDefaultRateCents: 6500, defaultPositionTypeId: pos["Deputy Sheriff"] }));
  });

  beforeEach(() => {
    resetGeocoder({ intervalMs: 0 });
    fetchMock = vi.fn(() => Promise.resolve(nominatim("30.5", "-86.1")));
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  test("create resolves the vendor rate, computes releaseAt and starts scheduled", async () => {
    const job = await make();
    expect(job.rateCents).toBe(7000);
    expect(job.state).toBe("scheduled");
    expect(job.releaseAt).toEqual(releaseAt(start, { releaseDayOfMonth: 15, releaseTime: "16:00" }));
    expect(await auditActions(job.id)).toContain("job.create");
  });

  test("the agency default applies when the vendor has none", async () => {
    const job = await run((tx) => createJob(coord, tx, base({ vendorId: otherVendorId })));
    expect(job.rateCents).toBe(6500);
  });

  test("only coordinators and admins create, update and cancel", async () => {
    await expect(run((tx) => createJob(deputy, tx, base()))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => createJob(vendorUser, tx, base()))).rejects.toBeInstanceOf(ForbiddenError);
    const job = await make();
    await expect(run((tx) => updateJob(deputy, tx, job.id, { title: "x" }, "one"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => cancelJob(deputy, tx, job.id, "no"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => createJob(admin, tx, base()))).resolves.toBeTruthy();
  });

  test("a resolved rate of zero is rejected", async () => {
    await expect(run((tx) => createJob(coord, tx, base({ rateCents: 0 })))).rejects.toBeInstanceOf(ValidationError);
  });

  test("end must be after start", async () => {
    await expect(run((tx) => createJob(coord, tx, base({ endAt: start })))).rejects.toBeInstanceOf(ValidationError);
    await expect(run((tx) => createJob(coord, tx, base({ endAt: new Date(start.getTime() - 1) })))).rejects.toBeInstanceOf(ValidationError);
  });

  test("no positions given yields one default position; counts must be at least 1", async () => {
    const job = await make();
    const detail = await run((tx) => getJob(coord, tx, job.id));
    expect(detail.positions).toHaveLength(1);
    expect(detail.positions[0].positionTypeId).toBe(pos["Deputy Sheriff"]);
    expect(detail.personnelTotal).toBe(1);
    await expect(make({ positions: [{ positionTypeId: pos["CSO"], count: 0 }] })).rejects.toBeInstanceOf(ValidationError);
  });

  test("four position types store four positions and a total of 17", async () => {
    const job = await make({
      positions: [
        { positionTypeId: pos["Dispatcher"], count: 1 },
        { positionTypeId: pos["Incident Commander"], count: 1 },
        { positionTypeId: pos["Deputy Sheriff"], count: 14 },
        { positionTypeId: pos["CSO"], count: 1 },
      ],
    });
    const detail = await run((tx) => getJob(coord, tx, job.id));
    expect(detail.positions).toHaveLength(4);
    expect(detail.personnelTotal).toBe(17);
  });

  test("rank and qualification overrides are stored per position", async () => {
    const job = await make({
      positions: [
        { positionTypeId: pos["CSO"], count: 2, eligibleRankIdsOverride: [rank["Deputy Sheriff"]] },
        { positionTypeId: pos["Deputy Sheriff"], count: 1 },
      ],
    });
    const rows = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
    const cso = rows.find((r) => r.positionTypeId === pos["CSO"])!;
    const dep = rows.find((r) => r.positionTypeId === pos["Deputy Sheriff"])!;
    expect(cso.eligibleRankIdsOverride).toEqual([rank["Deputy Sheriff"]]);
    expect(dep.eligibleRankIdsOverride).toBeNull();
    await expect(make({ positions: [{ positionTypeId: pos["CSO"], count: 1, eligibleRankIdsOverride: ["nope"] }] })).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  test("flex windows must contain the scheduled times", async () => {
    const ok = { earliestStartAt: new Date(start.getTime() - 3_600_000), latestEndAt: new Date(end.getTime() + 3_600_000), allowShorter: true };
    const job = await make({ flex: ok });
    expect(job.flexAllowShorter).toBe(true);
    expect(job.flexEarliestStartAt).toEqual(ok.earliestStartAt);
    await expect(make({ flex: { ...ok, earliestStartAt: new Date(start.getTime() + 1) } })).rejects.toBeInstanceOf(ValidationError);
    await expect(make({ flex: { ...ok, latestEndAt: new Date(end.getTime() - 1) } })).rejects.toBeInstanceOf(ValidationError);
  });

  test("ops plan due defaults to start minus the default due hours; no IC position is allowed", async () => {
    const job = await make({ opsPlanRequired: true });
    expect(job.opsPlanDueAt).toEqual(new Date(start.getTime() - 72 * 3_600_000));
    const own = new Date(start.getTime() - 5 * 3_600_000);
    expect((await make({ opsPlanRequired: true, opsPlanDueAt: own })).opsPlanDueAt).toEqual(own);
    expect((await make()).opsPlanDueAt).toBeNull();
  });

  describe("officer safety", () => {
    test("two addresses are stored with pins and who added them", async () => {
      const job = await make({
        safety: {
          notes: "Known fights near the east gate",
          addresses: [
            { address: "1 Main St, Cedar Springs, FL", description: "Gate" },
            { address: "9 Oak Ave, Cedar Springs, FL", description: "Lot" },
          ],
        },
      });
      const detail = await run((tx) => getJob(coord, tx, job.id));
      expect(detail.safety!.addresses).toHaveLength(2);
      for (const a of detail.safety!.addresses) {
        expect(a.lat).toBeCloseTo(30.5, 10);
        expect(a.lng).toBeCloseTo(-86.1, 10);
        expect(a.addedBy).toBe(coord.userId);
        expect(a.addedByName).toBe("jcoord");
        expect(a.addedByRole).toBe("coordinator");
        expect(a.addedAt).toBeInstanceOf(Date);
        expect(a.editedBy).toBeNull();
      }
      expect(detail.safety!.notes).toBe("Known fights near the east gate");
      expect(detail.safety!.addedByName).toBe("jcoord");
      expect(detail.safety!.addedByRole).toBe("coordinator");
      expect(detail.safety!.editedAt).toBeNull();
    });

    test("a failed lookup keeps the address without a pin", async () => {
      fetchMock.mockImplementation(() => Promise.resolve(new Response("down", { status: 500 })));
      const job = await make({ safety: { notes: "", addresses: [{ address: "Unknown Rd", description: "x" }] } });
      const [a] = await get().db.select().from(jobSafetyAddresses).where(eq(jobSafetyAddresses.jobId, job.id));
      expect(a.address).toBe("Unknown Rd");
      expect(a.lat).toBeNull();
      expect(a.lng).toBeNull();
    });

    test("pre-resolved pins are not looked up again", async () => {
      fetchMock.mockClear();
      const job = await make({ safety: { notes: "n", addresses: [{ address: "5 Elm", description: "", lat: 1, lng: 2 }] } });
      expect(fetchMock).not.toHaveBeenCalled();
      const [a] = await get().db.select().from(jobSafetyAddresses).where(eq(jobSafetyAddresses.jobId, job.id));
      expect([a.lat, a.lng]).toEqual([1, 2]);
    });

    test("editing a note records the editor and keeps the earlier text in audit", async () => {
      const job = await run((tx) =>
        createJob(coord, tx, base({ safety: { notes: "first note", addresses: [] } })),
      );
      await run((tx) => updateJob(admin, tx, job.id, { safety: { notes: "second note", addresses: [] } }, "one"));
      const detail = await run((tx) => getJob(coord, tx, job.id));
      expect(detail.safety!.notes).toBe("second note");
      expect(detail.safety!.addedByName).toBe("jcoord");
      expect(detail.safety!.editedBy).toBe(admin.userId);
      expect(detail.safety!.editedByName).toBe("jadmin");
      expect(detail.safety!.editedAt).toBeInstanceOf(Date);
      const audits = await get().db.select().from(auditLog).where(eq(auditLog.entityId, job.id));
      const edit = audits.filter((a) => a.action === "job.safety_update").sort((x, y) => x.at.getTime() - y.at.getTime()).at(-1)!;
      expect((edit.before as { notes: string }).notes).toBe("first note");
      expect((edit.after as { notes: string }).notes).toBe("second note");
    });

    test("changing an address description stamps its editor; removing keeps it in audit", async () => {
      const job = await make({
        safety: { notes: "n", addresses: [{ address: "1 A St", description: "old" }, { address: "2 B St", description: "keep" }] },
      });
      await run((tx) => updateJob(admin, tx, job.id, { safety: { notes: "n", addresses: [{ address: "1 a  st", description: "new" }] } }, "one"));
      const detail = await run((tx) => getJob(coord, tx, job.id));
      expect(detail.safety!.addresses).toHaveLength(1);
      expect(detail.safety!.addresses[0].description).toBe("new");
      expect(detail.safety!.addresses[0].editedByName).toBe("jadmin");
      const audits = await get().db.select().from(auditLog).where(eq(auditLog.entityId, job.id));
      const edit = audits.filter((a) => a.action === "job.safety_update").sort((x, y) => x.at.getTime() - y.at.getTime()).at(-1)!;
      expect((edit.before as { addresses: unknown[] }).addresses).toHaveLength(2);
    });

    test("a vendor-added note reports the vendor role", async () => {
      const job = await make();
      const { applySafety } = await import("@/domain/jobs/safety");
      await run((tx) => applySafety(vendorUser, tx, job.id, { notes: "Gate is locked after 9", addresses: [] }));
      const detail = await run((tx) => getJob(coord, tx, job.id));
      expect(detail.safety!.addedByRole).toBe("vendor");
    });

    test("changing safety on a job with sign-ups writes job.safety_changed audit", async () => {
      const job = await make({ safety: { notes: "a", addresses: [] } });
      await run((tx) => updateJob(coord, tx, job.id, { safety: { notes: "b", addresses: [] } }, "one"));
      expect(await auditActions(job.id)).not.toContain("job.safety_changed");
      await addSignup(job.id, deputy.userId);
      await run((tx) => updateJob(coord, tx, job.id, { safety: { notes: "c", addresses: [] } }, "one"));
      expect(await auditActions(job.id)).toContain("job.safety_changed");
    });

    test("a vendor sees safety only on their own job", async () => {
      const job = await make({ safety: { notes: "visible to owner", addresses: [] } });
      const own = await run((tx) => getJob(vendorUser, tx, job.id));
      expect(own.safety!.notes).toBe("visible to owner");
      await expect(run((tx) => getJob(otherVendorUser, tx, job.id))).rejects.toBeInstanceOf(NotFoundError);
    });
  });

  describe("updates", () => {
    test("a rate change on a job with sign-ups writes job.rate_changed audit", async () => {
      const job = await make();
      await run((tx) => updateJob(coord, tx, job.id, { rateCents: 7500 }, "one"));
      expect(await auditActions(job.id)).not.toContain("job.rate_changed");
      await addSignup(job.id, deputy.userId);
      const [after] = await run((tx) => updateJob(coord, tx, job.id, { rateCents: 8000 }, "one"));
      expect(after.rateCents).toBe(8000);
      const rows = (await get().db.select().from(auditLog).where(eq(auditLog.entityId, job.id))).filter((a) => a.action === "job.rate_changed");
      expect(rows).toHaveLength(1);
      expect(rows[0].before).toEqual({ rateCents: 7500 });
      expect(rows[0].after).toEqual({ rateCents: 8000 });
    });

    test("an edit alerts the people on the job once with every change and carries fixed times to their plans", async () => {
      const { db } = get();
      const person = (await makeUser(db, "personnel", "jchange@example.test")).actor;
      const job = await make();
      await addSignup(job.id, person.userId);
      await expect(run((tx) => updateJob(coord, tx, job.id, { vendorId: otherVendorId }, "one"))).rejects.toThrow(new ValidationError("A job cannot move to another vendor."));
      await expect(run((tx) => updateJob(coord, tx, job.id, { title: "  " }, "one"))).rejects.toThrow(new ValidationError("A title is required."));
      const newStart = agencyInstant(2035, 6, 10, 18, 0);
      const newEnd = agencyInstant(2035, 6, 11, 0, 0);
      const [after] = await run((tx) => updateJob(coord, tx, job.id, { startAt: newStart, endAt: newEnd, rateCents: 9000, description: "New text" }, "one"));
      expect(after.description).toBe("New text");
      const [a] = await db.select().from(assignments).where(eq(assignments.jobId, job.id));
      expect([a.plannedStartAt, a.plannedEndAt]).toEqual([newStart, newEnd]);
      const alerts = await db.select().from(notifications).where(and(eq(notifications.userId, person.userId), eq(notifications.type, "job.changed")));
      expect(alerts.map((n) => [n.title, n.body])).toEqual([
        ["Detail changed: Stadium security", "The hourly rate changed from $70.00 to $90.00. The time changed to Jun 10, 2035, 6:00 PM to Jun 11, 2035, 12:00 AM."],
      ]);
    });

    test("moving the start recomputes releaseAt", async () => {
      const job = await make();
      const [after] = await run((tx) => updateJob(coord, tx, job.id, { startAt: agencyInstant(2035, 8, 10, 17, 0), endAt: agencyInstant(2035, 8, 10, 23, 0) }, "one"));
      expect(after.releaseAt).toEqual(agencyInstant(2035, 7, 15, 16, 0));
    });

    test("positions cannot drop below sign-ups or lose a position that has them", async () => {
      const job = await make({ positions: [{ positionTypeId: pos["Deputy Sheriff"], count: 2 }] });
      await addSignup(job.id, deputy.userId);
      await expect(run((tx) => updateJob(coord, tx, job.id, { positions: [{ positionTypeId: pos["CSO"], count: 1 }] }, "one"))).rejects.toBeInstanceOf(
        ValidationError,
      );
      await run((tx) => updateJob(coord, tx, job.id, { positions: [{ positionTypeId: pos["Deputy Sheriff"], count: 3 }, { positionTypeId: pos["CSO"], count: 1 }] }, "one"));
      expect((await run((tx) => getJob(coord, tx, job.id))).personnelTotal).toBe(4);
    });

    test("series scope updates this and later jobs in the series, not earlier ones", async () => {
      const { db } = get();
      const a = await make();
      const b = await make({ startAt: agencyInstant(2035, 6, 11, 17, 0), endAt: agencyInstant(2035, 6, 11, 23, 0) });
      const c = await make({ startAt: agencyInstant(2035, 6, 12, 17, 0), endAt: agencyInstant(2035, 6, 12, 23, 0) });
      const { jobSeries } = await import("@/db/schema");
      const [s] = await db.insert(jobSeries).values({ name: "Games" }).returning();
      for (const j of [a, b, c]) await db.update(jobs).set({ seriesId: s.id }).where(eq(jobs.id, j.id));
      const out = await run((tx) => updateJob(coord, tx, b.id, { title: "Season games" }, "series"));
      expect(out.map((j) => j.id).sort(byText)).toEqual([b.id, c.id].sort(byText));
      expect((await db.select().from(jobs).where(eq(jobs.id, a.id)))[0].title).toBe("Stadium security");
      await expect(run((tx) => updateJob(coord, tx, b.id, { startAt: start }, "series"))).rejects.toBeInstanceOf(ValidationError);
    });

    test("cancel stores the reason and blocks further edits; hold can be released", async () => {
      const held = await make({ held: true });
      expect(held.held).toBe(true);
      expect((await run((tx) => releaseHold(coord, tx, held.id))).held).toBe(false);
      const job = await make();
      await expect(run((tx) => cancelJob(coord, tx, job.id, "  "))).rejects.toBeInstanceOf(ValidationError);
      const done = await run((tx) => cancelJob(coord, tx, job.id, "Event rained out"));
      expect(done.state).toBe("canceled");
      expect(done.cancelReason).toBe("Event rained out");
      expect(done.canceledAt).toBeInstanceOf(Date);
      await expect(run((tx) => updateJob(coord, tx, job.id, { title: "x" }, "one"))).rejects.toBeInstanceOf(ValidationError);
      expect(await auditActions(job.id)).toContain("job.cancel");
    });
  });

  describe("review fixes", () => {
    test("a job of a deactivated type can still be edited", async () => {
      const { db } = get();
      const [t] = await db.insert(jobTypes).values({ name: "Retired type" }).returning();
      const job = await make({ typeId: t.id });
      await db.update(jobTypes).set({ active: false }).where(eq(jobTypes.id, t.id));
      const [after] = await run((tx) => updateJob(coord, tx, job.id, { title: "Still editable" }, "one"));
      expect(after.title).toBe("Still editable");
      await expect(run((tx) => updateJob(coord, tx, job.id, { typeId: t.id, notes: "x" }, "one"))).resolves.toBeTruthy();
      await expect(make({ typeId: t.id })).rejects.toBeInstanceOf(ValidationError);
    });

    test("a position-only change writes job.update audit with positions before and after", async () => {
      const job = await make({ positions: [{ positionTypeId: pos["Deputy Sheriff"], count: 2 }] });
      await run((tx) => updateJob(coord, tx, job.id, { positions: [{ positionTypeId: pos["Deputy Sheriff"], count: 3 }, { positionTypeId: pos["CSO"], count: 1 }] }, "one"));
      const rows = (await get().db.select().from(auditLog).where(eq(auditLog.entityId, job.id))).filter((a) => a.action === "job.update");
      expect(rows).toHaveLength(1);
      const b = (rows[0].before as { positions: { count: number }[] }).positions;
      const a = (rows[0].after as { positions: { count: number }[] }).positions;
      expect(b.map((p) => p.count)).toEqual([2]);
      expect(a.map((p) => p.count).sort(byNumber)).toEqual([1, 3]);
    });

    test("createJob without a positions field applies the default position", async () => {
      const input = base() as Partial<JobInput>;
      delete input.positions;
      const job = await run((tx) => createJob(coord, tx, input as JobInput));
      expect((await run((tx) => getJob(coord, tx, job.id))).positions).toHaveLength(1);
    });

    test("more than 10 safety addresses are rejected", async () => {
      const addresses = Array.from({ length: 11 }, (_, i) => ({ address: `${i} Main St`, description: "", lat: 1, lng: 2 }));
      await expect(make({ safety: { notes: "n", addresses } })).rejects.toBeInstanceOf(ValidationError);
      const { resolveSafetyPins } = await import("@/domain/jobs/safety");
      await expect(resolveSafetyPins({ notes: "n", addresses })).rejects.toBeInstanceOf(ValidationError);
    });
  });

  describe("listing", () => {
    test("filters by window, state, text and mine; vendors see only their own", async () => {
      const w0 = agencyInstant(2040, 1, 1, 0, 0);
      const w1 = agencyInstant(2040, 1, 31, 0, 0);
      const at = (d: number) => ({ startAt: agencyInstant(2040, 1, d, 17, 0), endAt: agencyInstant(2040, 1, d, 23, 0) });
      const j1 = await make({ ...at(5), title: "Parade route" });
      const j2 = await make({ ...at(6), title: "Fair gate", vendorId: otherVendorId });
      await make({ startAt: agencyInstant(2041, 1, 5, 17, 0), endAt: agencyInstant(2041, 1, 5, 23, 0) });
      const all = await run((tx) => listJobs(coord, tx, { from: w0, to: w1 }, 1));
      expect(all.map((j) => j.id)).toEqual([j1.id, j2.id]);
      expect((await run((tx) => listJobs(coord, tx, { from: w0, to: w1, text: "parade" }, 1))).map((j) => j.id)).toEqual([j1.id]);
      expect(await run((tx) => listJobs(coord, tx, { from: w0, to: w1, status: ["canceled"] }, 1))).toEqual([]);
      expect((await run((tx) => listJobs(coord, tx, { from: w0, to: w1, vendorIds: [otherVendorId] }, 1))).map((j) => j.id)).toEqual([j2.id]);
      expect((await run((tx) => listJobs(vendorUser, tx, { from: w0, to: w1 }, 1))).map((j) => j.id)).toEqual([j1.id]);
      expect(await run((tx) => listJobs(deputy, tx, { from: w0, to: w1, mine: true }, 1))).toEqual([]);
      await addSignup(j2.id, deputy.userId);
      expect((await run((tx) => listJobs(deputy, tx, { from: w0, to: w1, mine: true }, 1))).map((j) => j.id)).toEqual([j2.id]);
    });
  });

  describe("contract status", () => {
    test("vendor contract, detail attachment, then missing; never blocks creation", async () => {
      const { db } = get();
      const [v] = await db.insert(vendors).values({ name: "Gamma", defaultRateCents: 5000 }).returning();
      const job = await run((tx) => createJob(coord, tx, base({ vendorId: v.id })));
      expect(await run((tx) => jobContractStatus(tx, job.id))).toBe("missing");
      await db.insert(jobAttachments).values({ jobId: job.id, label: "Signed", url: "https://example.test/c.pdf", isContract: true });
      expect(await run((tx) => jobContractStatus(tx, job.id))).toBe("detail");
      await db.insert(vendorDocuments).values({ vendorId: v.id, kind: "contract", label: "MSA", url: "https://example.test/m.pdf", signedOn: "2030-01-01", expiresOn: "2040-01-01" });
      expect(await run((tx) => jobContractStatus(tx, job.id))).toBe("vendor");
      await db.update(vendorDocuments).set({ expiresOn: "2031-01-01" }).where(eq(vendorDocuments.vendorId, v.id));
      expect(await run((tx) => jobContractStatus(tx, job.id))).toBe("detail");
    });

    test("detailsMissingContract lists upcoming and recent jobs only", async () => {
      const { db } = get();
      const [v] = await db.insert(vendors).values({ name: "Delta", defaultRateCents: 5000 }).returning();
      const now = new Date();
      const day = 86_400_000;
      const mk = (offset: number, title: string) =>
        run((tx) =>
          createJob(coord, tx, base({ vendorId: v.id, title, startAt: new Date(now.getTime() + offset * day), endAt: new Date(now.getTime() + offset * day + 4 * 3_600_000) })),
        );
      const upcoming = await mk(5, "upcoming");
      const recent = await mk(-3, "recent");
      await mk(-90, "old");
      const canceled = await mk(6, "canceled");
      await run((tx) => cancelJob(coord, tx, canceled.id, "x"));
      const covered = await mk(7, "covered");
      await db.insert(jobAttachments).values({ jobId: covered.id, label: "c", url: "https://example.test/c", isContract: true });
      const ids = (await run((tx) => detailsMissingContract(tx, now))).filter((j) => j.vendorId === v.id).map((j) => j.id);
      expect(ids).toEqual([recent.id, upcoming.id]);
    });

    test("deputies never see contract attachments; coordinators and the vendor do", async () => {
      const job = await make();
      const { db } = get();
      await db.insert(jobAttachments).values([
        { jobId: job.id, label: "Contract", url: "https://example.test/c", isContract: true },
        { jobId: job.id, label: "Map", url: "https://example.test/m", isContract: false },
      ]);
      expect((await run((tx) => getJob(deputy, tx, job.id))).attachments.map((a) => a.label)).toEqual(["Map"]);
      expect((await run((tx) => getJob(deputy, tx, job.id))).contractStatus).toBeNull();
      expect((await run((tx) => getJob(coord, tx, job.id))).attachments).toHaveLength(2);
      expect((await run((tx) => getJob(vendorUser, tx, job.id))).attachments).toHaveLength(2);
    });
  });
});
