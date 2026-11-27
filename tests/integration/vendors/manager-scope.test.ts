import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { byText } from "@/lib/sort";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { call, sessionToken, bearer } from "../api/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, jobChangeRequests, jobPositions, jobs, jobTypes, notifications, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assignPerson, markNoShow, removePerson } from "@/domain/assignments/coordinator";
import { loadActiveActor } from "@/domain/auth/sign-in-policy";
import { auditView } from "@/domain/admin/views";
import { coordinatorTodo, detailFormOptions, jobAdmin, paymentsBoard, staffDirectory, vendorRecord } from "@/domain/coordinator/views";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { copyJob, createRecurringJobs } from "@/domain/jobs/copy";
import { cancelJob, createJob, getJob, holdJob, listJobs, reactivateJob, releaseJob, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { ScheduleConflictError } from "@/domain/jobs/schedule-conflicts";
import { runReport } from "@/domain/reports/engine";
import { updateSettings } from "@/domain/settings/settings";
import { agencyInstant } from "@/domain/time/agency-time";
import { approveJobChange, approveRequest, declineJobChange, declineRequest, submitRequest } from "@/domain/vendor-portal/requests";
import { addVendorContact, listVendorContacts } from "@/domain/vendors/contacts";
import { managerOverview, setManagedVendors } from "@/domain/vendors/managers";
import { addLocation, listLocations, listVendors } from "@/domain/vendors/vendors";
import { w9History } from "@/domain/w9/w9";
import { POST as postJob } from "@/app/api/v1/jobs/route";
import { PATCH as patchJob } from "@/app/api/v1/jobs/[id]/route";
import { POST as postCancel } from "@/app/api/v1/jobs/[id]/cancel/route";

const NOW = new Date("2035-01-15T12:00:00Z");

describe("a vendor manager's scope (owner decision 2026-11-27)", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let sergeant: Actor;
  let deputy: Actor;
  let typeId: string;

  const input = (vendorId: string, day: number, extra: Partial<JobInput> = {}): JobInput => ({
    vendorId,
    locationId: null,
    typeId,
    title: "Friday game",
    description: "Home game",
    notes: null,
    startAt: agencyInstant(2035, 6, day, 18, 0),
    endAt: agencyInstant(2035, 6, day, 22, 0),
    rateCents: null,
    positions: [{ positionTypeId: f.pos["School Resource Deputy"], count: 1 }, { positionTypeId: f.pos["Deputy Sheriff"], count: 1 }],
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: null,
    contactPhone: null,
    held: false,
    flex: null,
    ...extra,
  });

  const audited = async (action: string, entityId: string) =>
    get()
      .db.select({ actor: auditLog.actorUserId })
      .from(auditLog)
      .where(and(eq(auditLog.action, action), eq(auditLog.entityId, entityId)));

  beforeAll(async () => {
    f = await setupFixture(get().db, "scope");
    typeId = (await get().db.select().from(jobTypes).limit(1))[0].id;
    const plain = await f.person();
    deputy = await f.person();
    await f.run((tx) => setManagedVendors(f.coord, tx, plain.userId, [f.vendorId]));
    sergeant = (await f.run((tx) => loadActiveActor(tx, plain.userId)))!;
  });

  test("creates, edits, holds, releases, cancels and reactivates details of a managed vendor, each audited under their name", async () => {
    const job = await f.run((tx) => createJob(sergeant, tx, input(f.vendorId, 1)));
    expect(await audited("job.create", job.id)).toEqual([{ actor: sergeant.userId }]);
    const positions = await get().db.select().from(jobPositions).where(eq(jobPositions.jobId, job.id));
    expect(positions.map((p) => p.positionTypeId).toSorted(byText)).toEqual([f.pos["School Resource Deputy"], f.pos["Deputy Sheriff"]].toSorted(byText));

    await f.run((tx) => updateJob(sergeant, tx, job.id, { description: "Rivalry game", rateCents: 7500 }, "one"));
    expect(await audited("job.update", job.id)).toEqual([{ actor: sergeant.userId }]);
    await f.run((tx) => holdJob(sergeant, tx, job.id, "one"));
    await f.run((tx) => releaseJob(sergeant, tx, job.id, { scope: "one", now: true }));
    expect(await audited("job.release_now", job.id)).toEqual([{ actor: sergeant.userId }]);
    await f.run((tx) => cancelJob(sergeant, tx, job.id, "Game moved"));
    await f.run((tx) => reactivateJob(sergeant, tx, job.id, "Game back on", NOW));
    expect(await audited("job.reactivate", job.id)).toEqual([{ actor: sergeant.userId }]);
    const copies = await f.run((tx) => copyJob(sergeant, tx, job.id, { kind: "dates", dates: ["2035-06-08"] }, { now: NOW }));
    expect(copies.jobs).toHaveLength(1);
    expect(await f.run((tx) => createRecurringJobs(sergeant, tx, job.id, { kind: "weekly", every: 1, weekdays: [5], end: { count: 2 } }, NOW))).not.toHaveLength(0);
  });

  test("the same actions on another vendor's detail are refused", async () => {
    await expect(f.run((tx) => createJob(sergeant, tx, input(f.otherVendorId, 2)))).rejects.toBeInstanceOf(ForbiddenError);
    const { job } = await f.mkJob({ vendor: f.otherVendorId });
    await expect(f.run((tx) => updateJob(sergeant, tx, job.id, { description: "x" }, "one"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => holdJob(sergeant, tx, job.id, "one"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => releaseJob(sergeant, tx, job.id, { scope: "one", now: true }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => cancelJob(sergeant, tx, job.id, "No"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => copyJob(sergeant, tx, job.id, { kind: "dates", dates: ["2035-06-09"] }, { now: NOW }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => jobAdmin(sergeant, tx, job.id))).rejects.toBeInstanceOf(ForbiddenError);
    await get().db.update(jobs).set({ state: "canceled" }).where(eq(jobs.id, job.id));
    await expect(f.run((tx) => reactivateJob(sergeant, tx, job.id, "Back", NOW))).rejects.toBeInstanceOf(ForbiddenError);
    // A plain deputy cannot do any of it for the managed vendor either.
    await expect(f.run((tx) => createJob(deputy, tx, input(f.vendorId, 3)))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("keeps the rate inside the agency range: no out-of-range approval", async () => {
    await f.run((tx) => updateSettings(f.coord, tx, { rateMinCents: 5000, rateMaxCents: 9000 }));
    await expect(f.run((tx) => createJob(sergeant, tx, input(f.vendorId, 4, { rateCents: 12000, rateOverrideReason: "Holiday" })))).rejects.toBeInstanceOf(ValidationError);
    expect((await f.run((tx) => createJob(sergeant, tx, input(f.vendorId, 4, { rateCents: 8500 })))).rateCents).toBe(8500);
    await f.run((tx) => updateSettings(f.coord, tx, { rateMinCents: null, rateMaxCents: null }));
  });

  test("assigns and removes people with the coordinators' conflict and override rules, only on managed vendors", async () => {
    const { job, positionId } = await f.mkJob({ count: 2 });
    const a = await f.run((tx) => assignPerson(sergeant, tx, positionId, deputy.userId, { notify: true }));
    expect(await audited("assignment.assign", a.id)).toEqual([{ actor: sergeant.userId }]);
    // An overlapping detail needs an override reason, as for a coordinator.
    const { positionId: overlap } = await f.mkJob({ count: 1 });
    const [o] = await get().db.select({ jobId: jobPositions.jobId }).from(jobPositions).where(eq(jobPositions.id, overlap));
    await get().db.update(jobs).set({ startAt: job.startAt, endAt: job.endAt }).where(eq(jobs.id, o.jobId));
    await expect(f.run((tx) => assignPerson(sergeant, tx, overlap, deputy.userId, { notify: false }))).rejects.toBeInstanceOf(RuleViolation);
    const forced = await f.run((tx) => assignPerson(sergeant, tx, overlap, deputy.userId, { notify: false, overrideReason: "Same site, back to back" }));
    expect(forced.overrideReason).toBe("Same site, back to back");
    await f.run((tx) => removePerson(sergeant, tx, a.id, "Needed at the school"));
    expect(await audited("assignment.remove", a.id)).toEqual([{ actor: sergeant.userId }]);
    await expect(f.run((tx) => markNoShow(sergeant, tx, forced.id, "Did not come"))).rejects.toBeInstanceOf(ForbiddenError);

    const other = await f.mkJob({ vendor: f.otherVendorId });
    await expect(f.run((tx) => assignPerson(sergeant, tx, other.positionId, deputy.userId, { notify: false }))).rejects.toBeInstanceOf(ForbiddenError);
    const [theirs] = await get().db.insert(assignments).values({ jobId: other.job.id, jobPositionId: other.positionId, userId: deputy.userId, status: "signed_up" }).returning();
    await expect(f.run((tx) => removePerson(sergeant, tx, theirs.id, "No"))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a time edit that puts a deputy into a conflict needs the same override and reason", async () => {
    const a = await f.mkJob();
    const b = await f.mkJob();
    await get().db.insert(assignments).values([
      { jobId: a.job.id, jobPositionId: a.positionId, userId: deputy.userId, status: "signed_up" },
      { jobId: b.job.id, jobPositionId: b.positionId, userId: deputy.userId, status: "signed_up" },
    ]);
    const move = { startAt: b.job.startAt, endAt: b.job.endAt };
    const refused = await f.run((tx) => updateJob(sergeant, tx, a.job.id, move, "one")).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(ScheduleConflictError);
    const fingerprint = (refused as ScheduleConflictError).fingerprints[a.job.id];
    await f.run((tx) => updateJob(sergeant, tx, a.job.id, { ...move, conflictOverride: { reason: "Short game, deputy agreed", fingerprint } }, "one"));
    const rows = await get().db.select({ reason: auditLog.reason, actor: auditLog.actorUserId }).from(auditLog).where(and(eq(auditLog.entityId, a.job.id), eq(auditLog.action, "job.schedule_conflict_override")));
    expect(rows).toEqual([{ reason: "Short game, deputy agreed", actor: sergeant.userId }]);
  });

  test("sees the roster and sign-up history, and the picker of people, for a managed vendor's detail", async () => {
    const { job, positionId } = await f.mkJob();
    await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: deputy.userId, status: "signed_up" });
    const admin = await f.run((tx) => jobAdmin(sergeant, tx, job.id));
    expect(admin.roster.map((r) => r.userId)).toEqual([deputy.userId]);
    expect((await f.run((tx) => staffDirectory(sergeant, tx))).some((p) => p.id === deputy.userId)).toBe(true);
    await expect(f.run((tx) => staffDirectory(deputy, tx))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("approves and declines the managed vendor's requests and changes, never another vendor's", async () => {
    const mk = async (vendor: string) => {
      const { job } = await f.mkJob({ vendor });
      await get().db.update(jobs).set({ state: "requested" }).where(eq(jobs.id, job.id));
      return job.id;
    };
    const mine = await mk(f.vendorId);
    // A deputy never sees a request; the manager sees their vendor's.
    expect((await f.run((tx) => getJob(sergeant, tx, mine))).state).toBe("requested");
    await expect(f.run((tx) => getJob(deputy, tx, mine))).rejects.toBeInstanceOf(NotFoundError);
    await f.run((tx) => approveRequest(sergeant, tx, mine));
    expect(await audited("job.request_approve", mine)).toEqual([{ actor: sergeant.userId }]);
    const declined = await mk(f.vendorId);
    await f.run((tx) => declineRequest(sergeant, tx, declined, "No deputies that night"));
    const theirs = await mk(f.otherVendorId);
    await expect(f.run((tx) => getJob(sergeant, tx, theirs))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.run((tx) => approveRequest(sergeant, tx, theirs))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => declineRequest(sergeant, tx, theirs, "No"))).rejects.toBeInstanceOf(ForbiddenError);

    const change = async (jobId: string) =>
      (await get().db.insert(jobChangeRequests).values({ jobId, requestedBy: f.coord.userId, patch: { description: "Gate B" } }).returning())[0].id;
    const myJob = (await f.mkJob()).job.id;
    const c1 = await change(myJob);
    await f.run((tx) => approveJobChange(sergeant, tx, c1, NOW));
    const c2 = await change(myJob);
    await f.run((tx) => declineJobChange(sergeant, tx, c2, "Not needed", NOW));
    const otherJob = (await f.mkJob({ vendor: f.otherVendorId })).job.id;
    const otherChange = await change(otherJob);
    await expect(f.run((tx) => approveJobChange(sergeant, tx, otherChange, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => declineJobChange(sergeant, tx, otherChange, "No", NOW))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("keeps the managed vendor's locations and site contacts, not another vendor's", async () => {
    const loc = await f.run((tx) => addLocation(sergeant, tx, f.vendorId, { name: "Main gym", address: null, notes: null }));
    expect(await audited("vendor_location.create", loc.id)).toEqual([{ actor: sergeant.userId }]);
    expect((await f.run((tx) => listLocations(sergeant, tx, f.vendorId))).map((l) => l.id)).toContain(loc.id);
    const c = await f.run((tx) => addVendorContact(sergeant, tx, f.vendorId, { name: "Front office", phone: "850-555-0100" }));
    expect((await f.run((tx) => listVendorContacts(sergeant, tx, f.vendorId))).map((x) => x.id)).toContain(c.id);
    await expect(f.run((tx) => addLocation(sergeant, tx, f.otherVendorId, { name: "Field", address: null, notes: null }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => addVendorContact(sergeant, tx, f.otherVendorId, { name: "Office", phone: "850-555-0101" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => listLocations(sergeant, tx, f.otherVendorId))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("sees only the managed vendors in the detail form and the vendor list", async () => {
    const options = await f.run((tx) => detailFormOptions(sergeant, tx, NOW));
    expect(options.vendors.map((v) => v.id)).toEqual([f.vendorId]);
    expect(options.locations.every((l) => l.vendorId === f.vendorId)).toBe(true);
    expect(options.contacts.every((c) => c.vendorId === f.vendorId)).toBe(true);
    expect((await f.run((tx) => listVendors(sergeant, tx))).map((v) => v.id)).toEqual([f.vendorId]);
    await expect(f.run((tx) => detailFormOptions(deputy, tx, NOW))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("their open list includes their vendors' held details; nothing else changes", async () => {
    const held = await f.mkJob();
    await get().db.update(jobs).set({ held: true }).where(eq(jobs.id, held.job.id));
    const otherHeld = await f.mkJob({ vendor: f.otherVendorId });
    await get().db.update(jobs).set({ held: true }).where(eq(jobs.id, otherHeld.job.id));
    const window = { from: new Date("2035-01-01T00:00:00Z"), to: new Date("2036-01-01T00:00:00Z") };
    const ids = (await f.run((tx) => listJobs(sergeant, tx, window, 1))).map((j) => j.id);
    expect(ids).toContain(held.job.id);
    expect(ids).not.toContain(otherHeld.job.id);
    const theirs = (await f.run((tx) => listJobs(deputy, tx, window, 1))).map((j) => j.id);
    expect(theirs).not.toContain(held.job.id);
  });

  test("never sees W-9s, payments, other vendors' records, staff reports, To-do, Management or the audit log", async () => {
    await expect(f.run((tx) => w9History(sergeant, tx, deputy.userId))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => paymentsBoard(sergeant, tx, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => vendorRecord(sergeant, tx, f.vendorId, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => vendorRecord(sergeant, tx, f.otherVendorId, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => coordinatorTodo(sergeant, tx, NOW))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => auditView(sergeant, tx, {}, 1))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => runReport(sergeant, tx, { kind: "personnel_activity" } as never))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => setManagedVendors(sergeant, tx, deputy.userId, [f.vendorId]))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the Manage overview lists only their vendors' requests and upcoming details", async () => {
    const mine = await f.mkJob();
    const req = await f.mkJob();
    await get().db.update(jobs).set({ state: "requested" }).where(eq(jobs.id, req.job.id));
    const theirs = await f.mkJob({ vendor: f.otherVendorId });
    const view = await f.run((tx) => managerOverview(sergeant, tx, NOW));
    expect(view.vendors.map((v) => v.id)).toEqual([f.vendorId]);
    const ids = view.vendors[0].upcoming.map((d) => d.id);
    expect(ids).toContain(mine.job.id);
    expect(ids).not.toContain(theirs.job.id);
    expect(view.vendors[0].requests.map((d) => d.id)).toEqual([req.job.id]);
    await expect(f.run((tx) => managerOverview(deputy, tx, NOW))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("a vendor's request alerts its managers along with the coordinators; another vendor's does not", async () => {
    const login = async (vendorId: string, email: string) => {
      const { actor } = await makeUser(get().db, "vendor", email);
      await get().db.insert(vendorUsers).values({ userId: actor.userId, vendorId });
      return { ...actor, vendorId };
    };
    const alerts = async () =>
      (await get().db.select({ title: notifications.title }).from(notifications).where(and(eq(notifications.userId, sergeant.userId), eq(notifications.type, "vendor.request_submitted")))).map((n) => n.title);
    const request = (vendor: Actor, title: string) =>
      f.run((tx) => submitRequest(vendor, tx, { typeId, title, startAt: agencyInstant(2035, 9, 1, 18, 0), endAt: agencyInstant(2035, 9, 1, 22, 0) }, NOW));
    await request(await login(f.vendorId, "scope-v1@example.test"), "Homecoming");
    await request(await login(f.otherVendorId, "scope-v2@example.test"), "Other fair");
    expect(await alerts()).toEqual(["Vendor request: scope Vendor"]);
    const coordAlerts = await get().db.select().from(notifications).where(and(eq(notifications.userId, f.coord.userId), eq(notifications.type, "vendor.request_submitted")));
    expect(coordAlerts).toHaveLength(2);
  });

  test("the API follows the same scope", async () => {
    const token = await sessionToken(get().db, sergeant.userId);
    const body = (vendorId: string, day: number) => {
      const i = input(vendorId, day);
      return JSON.stringify({ ...i, startAt: i.startAt.toISOString(), endAt: i.endAt.toISOString() });
    };
    const headers = { ...bearer(token), "content-type": "application/json" };
    const made = await call(postJob, "/api/v1/jobs", { method: "POST", headers, body: body(f.vendorId, 10) });
    expect(made.status).toBe(201);
    const { id } = ((await made.json()) as { data: { id: string } }).data;
    expect((await call(patchJob, `/api/v1/jobs/${id}`, { method: "PATCH", headers, body: JSON.stringify({ description: "Updated" }), params: { id } })).status).toBe(200);
    expect((await call(postCancel, `/api/v1/jobs/${id}/cancel`, { method: "POST", headers, body: JSON.stringify({ reason: "Moved" }), params: { id } })).status).toBe(200);
    expect((await call(postJob, "/api/v1/jobs", { method: "POST", headers, body: body(f.otherVendorId, 11) })).status).toBe(403);
    const other = (await f.mkJob({ vendor: f.otherVendorId })).job.id;
    expect((await call(patchJob, `/api/v1/jobs/${other}`, { method: "PATCH", headers, body: JSON.stringify({ description: "x" }), params: { id: other } })).status).toBe(403);
    expect((await call(postCancel, `/api/v1/jobs/${other}/cancel`, { method: "POST", headers, body: JSON.stringify({ reason: "x" }), params: { id: other } })).status).toBe(403);
    const left = await get().db.select({ state: jobs.state }).from(jobs).where(inArray(jobs.id, [other]));
    expect(left[0].state).toBe("scheduled");
  });
});
