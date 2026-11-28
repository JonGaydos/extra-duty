import { beforeAll, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { bearer, call, sessionToken, useApiDb } from "../api/helpers";
import { useEmailQueue } from "../../setup/email-queue";
import { makeUser } from "../users/helpers";
import { setupFixture } from "../assignments/helpers";
import { assignments, auditLog, invoices, jobPositions, jobs, jobTypes, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { assignPerson } from "@/domain/assignments/coordinator";
import { eligibilityByPosition, signUp, watchJob } from "@/domain/assignments/signup";
import { loadActiveActor } from "@/domain/auth/sign-in-policy";
import { calendarEntries, detailCards, filterOptions, NO_FILTERS } from "@/domain/calendar/calendar";
import { ForbiddenError, NotFoundError, ValidationError } from "@/domain/errors";
import { confidentialViews, setConfidential } from "@/domain/jobs/confidential";
import { visibleJobIdByNumber } from "@/domain/jobs/detail-number";
import { createJob, getJob, holdJob, listJobs, openJob, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { linkableDetails, sendMessage } from "@/domain/messages/messages";
import { decodeNotifyJob, type NotifyJob } from "@/domain/notifications/notify";
import { calendarFeedFor, rotateCalendarToken } from "@/domain/planning/ics-feed";
import { taxYearSummary } from "@/domain/reports/tax";
import { runReport } from "@/domain/reports/engine";
import { agencyInstant } from "@/domain/time/agency-time";
import { vendorDetails, vendorInvoices } from "@/domain/vendor-portal/views";
import { vendorViewJob } from "@/domain/vendor-portal/requests";
import { managerOverview, setManagedVendors } from "@/domain/vendors/managers";
import { jobActivity, jobRoster } from "@/domain/personnel/views";
import { recomputeReleaseDates } from "@/domain/release/release";
import { copyJob } from "@/domain/jobs/copy";
import { NOTIFY_EMAIL_QUEUE, NOTIFY_PUSH_QUEUE } from "@/jobs/boss";
import { GET as listRoute } from "@/app/api/v1/jobs/route";
import { GET as getRoute } from "@/app/api/v1/jobs/[id]/route";

const NOW = new Date("2035-01-15T12:00:00Z");
const RANGE = { from: new Date("2035-01-01T00:00:00Z"), to: new Date("2035-12-31T00:00:00Z") };
const TITLE = "Governor visit escort";

describe("confidential details (owner decision 2026-11-27)", () => {
  const get = useApiDb();
  useEmailQueue(get);
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let deputy: Actor;
  let assigned: Actor;
  let manager: Actor;
  let vendor: Actor;
  let typeId: string;
  let job: typeof jobs.$inferSelect;
  let positionId: string;

  const input = (extra: Partial<JobInput> = {}): JobInput => ({
    vendorId: f.vendorId,
    locationId: null,
    typeId,
    title: TITLE,
    description: "Motorcade route and hotel",
    notes: null,
    startAt: agencyInstant(2035, 7, 4, 9, 0),
    endAt: agencyInstant(2035, 7, 4, 17, 0),
    rateCents: null,
    positions: [{ positionTypeId: f.pos["Deputy Sheriff"], count: 2 }],
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: null,
    contactPhone: null,
    held: false,
    flex: null,
    ...extra,
  });
  /** Queued notification deliveries for one person (email and push), decoded. */
  const queued = async (userId: string) => {
    const rows = (await get().db.execute(sql`select name, data from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${NOTIFY_PUSH_QUEUE})`)).rows as Array<{ name: string; data: NotifyJob }>;
    return rows.map((r) => ({ queue: r.name, ...decodeNotifyJob(r.data) })).filter((c) => c.userId === userId);
  };
  const ids = (rows: Array<{ id: string }>) => rows.map((r) => r.id);

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "conf");
    typeId = (await db.select().from(jobTypes).limit(1))[0].id;
    admin = (await makeUser(db, "admin", "conf-admin@example.test")).actor;
    deputy = await f.person();
    assigned = await f.person();
    const plain = await f.person();
    await f.run((tx) => setManagedVendors(f.coord, tx, plain.userId, [f.vendorId]));
    manager = (await f.run((tx) => loadActiveActor(tx, plain.userId)))!;
    const v = await makeUser(db, "vendor", "conf-vendor@example.test");
    await db.insert(vendorUsers).values({ userId: v.row.id, vendorId: f.vendorId });
    vendor = { ...v.actor, vendorId: f.vendorId };
    job = await f.run((tx) => createJob(f.coord, tx, input({ confidential: true, confidentialReason: "Dignitary protection" })));
    [{ id: positionId }] = await db.select({ id: jobPositions.id }).from(jobPositions).where(eq(jobPositions.jobId, job.id));
    await f.run((tx) => assignPerson(f.coord, tx, positionId, assigned.userId, { notify: true, now: NOW }));
  });

  test("marking a detail confidential needs a coordinator or admin and a reason, both ways, and is audited", async () => {
    expect(job.confidential).toBe(true);
    expect(job.held).toBe(false);
    expect(job.releaseAt).toBeNull();
    const [made] = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "job.confidential_on"), eq(auditLog.entityId, job.id)));
    expect(made).toMatchObject({ actorUserId: f.coord.userId, reason: "Dignitary protection" });

    await expect(f.run((tx) => createJob(f.coord, tx, input({ confidential: true, confidentialReason: " " })))).rejects.toBeInstanceOf(ValidationError);
    await expect(f.run((tx) => createJob(manager, tx, input({ confidential: true, confidentialReason: "VIP" })))).rejects.toBeInstanceOf(ForbiddenError);

    const other = await f.run((tx) => createJob(f.coord, tx, input({ title: "Parade" })));
    await expect(f.run((tx) => setConfidential(f.coord, tx, other.id, true, ""))).rejects.toBeInstanceOf(ValidationError);
    await expect(f.run((tx) => setConfidential(manager, tx, other.id, true, "VIP"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => setConfidential(deputy, tx, other.id, true, "VIP"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(f.run((tx) => updateJob(f.coord, tx, other.id, { confidential: true }, "one"))).rejects.toBeInstanceOf(ValidationError);
    const on = await f.run((tx) => updateJob(admin, tx, other.id, { confidential: true, confidentialReason: "Late VIP add" }, "one"));
    expect(on[0].confidential).toBe(true);
    const off = await f.run((tx) => setConfidential(f.coord, tx, other.id, false, "Public event after all"));
    expect(off.confidential).toBe(false);
    expect(off.releaseAt).not.toBeNull();
    const trail = await get().db.select({ action: auditLog.action, reason: auditLog.reason }).from(auditLog).where(eq(auditLog.entityId, other.id));
    expect(trail).toEqual(expect.arrayContaining([{ action: "job.confidential_on", reason: "Late VIP add" }, { action: "job.confidential_off", reason: "Public event after all" }]));
  });

  test("hold and release do not apply, and nobody can sign up, back up or watch", async () => {
    await expect(f.run((tx) => holdJob(f.coord, tx, job.id, "one"))).rejects.toBeInstanceOf(ValidationError);
    await expect(f.run((tx) => signUp(deputy, tx, positionId, { warningVersion: 1, now: NOW }))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.run((tx) => watchJob(deputy, tx, job.id, NOW))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.run((tx) => eligibilityByPosition(deputy, tx, job.id, NOW))).rejects.toBeInstanceOf(NotFoundError);
    // Even someone who can see it signs up only by assignment.
    const [rules] = await f.run((tx) => eligibilityByPosition(f.coord, tx, job.id, NOW));
    expect(rules.canSignUp).toBe(false);
    expect(rules.checks.find((c) => c.check === "state")?.message).toBe("Confidential: a coordinator assigns people");
  });

  test.each(["deputy", "manager", "vendor"] as const)("hidden from an unassigned %s in every list, search, the calendar, the map and by its number", async (who) => {
    const actor = { deputy, manager, vendor }[who]!;
    expect(ids(await f.run((tx) => listJobs(actor, tx, RANGE, 1)))).not.toContain(job.id);
    expect(ids(await f.run((tx) => listJobs(actor, tx, { ...RANGE, text: `#${job.number}` }, 1)))).toEqual([]);
    expect(ids(await f.run((tx) => listJobs(actor, tx, { ...RANGE, text: "Governor" }, 1)))).toEqual([]);
    await expect(f.run((tx) => getJob(actor, tx, job.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.run((tx) => openJob(actor, tx, job.id))).rejects.toBeInstanceOf(NotFoundError);
    expect(await f.run((tx) => visibleJobIdByNumber(actor, tx, job.number))).toBeNull();
    if (who === "vendor") {
      expect(ids(await f.run((tx) => vendorDetails(actor, tx, RANGE, NOW)))).not.toContain(job.id);
      await expect(f.run((tx) => vendorViewJob(actor, tx, job.id, NOW))).rejects.toBeInstanceOf(NotFoundError);
      return;
    }
    // Calendar and map read the same entries; the Details list reads the cards.
    expect(ids((await f.run((tx) => calendarEntries(actor, tx, RANGE, NO_FILTERS, NOW))).entries)).not.toContain(job.id);
    expect((await f.run((tx) => detailCards(actor, tx, RANGE, NO_FILTERS, NOW))).cards.map((c) => c.id)).not.toContain(job.id);
    expect(ids(await f.run((tx) => linkableDetails(actor, tx, NOW)))).not.toContain(job.id);
    await expect(f.run((tx) => sendMessage(actor, tx, { audiences: [{ kind: "job", jobId: job.id }], subject: "Hi", body: "Who is on it?" }, NOW))).rejects.toThrow();
    if (who === "manager") {
      const overview = await f.run((tx) => managerOverview(actor, tx, NOW));
      expect(JSON.stringify(overview)).not.toContain(job.id);
    }
  });

  test("hidden through the API, by id and by number, with the same answer as a detail that does not exist", async () => {
    const { db } = get();
    for (const actor of [deputy, manager, vendor]) {
      const headers = bearer(await sessionToken(db, actor.userId));
      const list = await call(listRoute, "/api/v1/jobs?from=2035-01-01&to=2035-12-31", { headers });
      expect(ids((await list.json()).data)).not.toContain(job.id);
      for (const id of [job.id, String(job.number)]) expect((await call(getRoute, `/api/v1/jobs/${id}`, { headers, params: { id } })).status).toBe(404);
    }
    const headers = bearer(await sessionToken(db, assigned.userId));
    const res = await call(getRoute, `/api/v1/jobs/${job.number}`, { headers, params: { id: String(job.number) } });
    expect(res.status).toBe(200);
  });

  test("the assigned person and staff see it in full, in the lists and calendar, with a Confidential mark", async () => {
    for (const actor of [assigned, f.coord, admin]) {
      expect((await f.run((tx) => getJob(actor, tx, job.id))).title).toBe(TITLE);
      expect(ids(await f.run((tx) => listJobs(actor, tx, RANGE, 1)))).toContain(job.id);
      const entry = (await f.run((tx) => calendarEntries(actor, tx, RANGE, NO_FILTERS, NOW))).entries.find((e) => e.id === job.id);
      expect(entry?.confidential).toBe(true);
    }
    expect(ids(await f.run((tx) => listJobs(assigned, tx, { ...RANGE, mine: true }, 1)))).toContain(job.id);
    // Staff lists can show only confidential details, or hide them.
    const only = (await f.run((tx) => calendarEntries(f.coord, tx, RANGE, { ...NO_FILTERS, confidential: "only" }, NOW))).entries;
    expect(only.length).toBeGreaterThan(0);
    expect(only.every((e) => e.confidential)).toBe(true);
    const hide = (await f.run((tx) => calendarEntries(f.coord, tx, RANGE, { ...NO_FILTERS, confidential: "hide" }, NOW))).entries;
    expect(ids(hide)).not.toContain(job.id);
    // A deputy's filter choices never list confidential people or places they cannot see.
    const options = await f.run((tx) => filterOptions(deputy, tx, RANGE));
    expect(options.people.map((p) => p.id)).not.toContain(assigned.userId);
  });

  test("every open of the detail is logged with who and when, for staff to review", async () => {
    await f.run((tx) => openJob(assigned, tx, job.id));
    await f.run((tx) => openJob(f.coord, tx, job.id));
    const views = await f.run((tx) => confidentialViews(f.coord, tx, job.id));
    expect(views.length).toBeGreaterThanOrEqual(2);
    expect(views.every((v) => v.name && v.at instanceof Date)).toBe(true);
    const rows = await get().db.select().from(auditLog).where(and(eq(auditLog.action, "job.confidential_view"), eq(auditLog.entityId, job.id)));
    expect(rows.map((r) => r.actorUserId)).toEqual(expect.arrayContaining([assigned.userId, f.coord.userId]));
    await expect(f.run((tx) => confidentialViews(assigned, tx, job.id))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("the assignment email and push say only the date; the inbox in the app keeps the detail", async () => {
    const sent = await queued(assigned.userId);
    expect(sent.length).toBeGreaterThan(0);
    for (const s of sent) {
      expect(s.body).toBe("You were assigned to a confidential detail on Jul 4, 2035. Open Signal 90 for the details.");
      expect(`${s.title} ${s.body}`).not.toMatch(/Governor|Motorcade|conf Vendor|#\d/);
    }
  });

  test("other alerts about it never reach people who cannot see it, and say nothing about it by email or push", async () => {
    const { db } = get();
    await db.execute(sql`delete from pgboss.job where name in (${NOTIFY_EMAIL_QUEUE}, ${NOTIFY_PUSH_QUEUE})`);
    await f.run((tx) => updateJob(f.coord, tx, job.id, { description: "New route" }, "one"));
    await f.run((tx) => updateJob(f.coord, tx, job.id, { startAt: agencyInstant(2035, 7, 4, 8, 0) }, "one"));
    for (const s of await queued(assigned.userId)) expect(`${s.title} ${s.body}`).not.toMatch(/Governor|Motorcade|route|conf Vendor/);
    expect(await queued(manager.userId)).toEqual([]);
    expect(await queued(vendor.userId)).toEqual([]);
  });

  test("the personal calendar feed shows Confidential detail with the times only", async () => {
    const token = await f.run((tx) => rotateCalendarToken(assigned, tx, NOW));
    const ics = (await f.run((tx) => calendarFeedFor(tx, token, NOW)))!;
    expect(ics).toContain("SUMMARY:Confidential detail");
    expect(ics).not.toMatch(/Governor|Motorcade|conf Vendor|LOCATION:|DESCRIPTION:Detail #/);
    expect(ics).toMatch(/DTSTART:20350704/);
  });

  test("billing is unchanged; the deputy's tax summary names it Confidential detail, staff reports mark it", async () => {
    const { db } = get();
    const [a] = await db.select().from(assignments).where(and(eq(assignments.jobId, job.id), eq(assignments.userId, assigned.userId)));
    await db.insert(invoices).values({ assignmentId: a.id, vendorId: f.vendorId, payeeUserId: assigned.userId, minutes: 480, rateCents: 7000, totalCents: 56000, status: "sent", sentAt: NOW });
    const tax = await f.run((tx) => taxYearSummary(assigned, tx, assigned.userId, 2035));
    expect(JSON.stringify(tax)).not.toContain("Governor");
    expect(JSON.stringify(tax)).toContain("Confidential detail");
    const vendorRows = await f.run((tx) => vendorInvoices(vendor, tx));
    expect(JSON.stringify(vendorRows)).not.toContain("Governor");
    const report = await f.run((tx) => runReport(f.coord, tx, { dataset: "jobs", from: RANGE.from, to: RANGE.to, filters: {}, groupBy: ["confidential"], measures: ["count"] }, NOW));
    expect(JSON.stringify(report.rows)).toContain("Confidential");
  });

  test("a vendor manager assigned to it sees it as a deputy, never with Manage", async () => {
    await f.run((tx) => assignPerson(f.coord, tx, positionId, manager.userId, { notify: false, overrideReason: "Needed a sergeant", now: NOW }));
    const seen = await f.run((tx) => getJob(manager, tx, job.id));
    expect(seen.contractStatus).toBeNull();
    await expect(f.run((tx) => updateJob(manager, tx, job.id, { description: "x" }, "one"))).rejects.toBeInstanceOf(ForbiddenError);
    expect(JSON.stringify(await f.run((tx) => managerOverview(manager, tx, NOW)))).not.toContain(job.id);
    await expect(f.run((tx) => assignPerson(manager, tx, positionId, deputy.userId, { notify: false, now: NOW }))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("its roster and activity answer as for a missing detail to anyone who may not see it", async () => {
    // The vendor manager is assigned by now (the test above), so the unassigned deputy stands for everyone else.
    await expect(f.run((tx) => jobRoster(deputy, tx, job.id))).rejects.toBeInstanceOf(NotFoundError);
    await expect(f.run((tx) => jobActivity(deputy, tx, job.id))).rejects.toBeInstanceOf(NotFoundError);
    expect((await f.run((tx) => jobRoster(assigned, tx, job.id))).some((r) => r.isYou)).toBe(true);
  });

  test("an API open is logged like an open in the app", async () => {
    const { db } = get();
    const before = await db.select().from(auditLog).where(and(eq(auditLog.action, "job.confidential_view"), eq(auditLog.entityId, job.id), eq(auditLog.actorUserId, assigned.userId)));
    const headers = bearer(await sessionToken(db, assigned.userId));
    expect((await call(getRoute, `/api/v1/jobs/${job.id}`, { headers, params: { id: job.id } })).status).toBe(200);
    const after = await db.select().from(auditLog).where(and(eq(auditLog.action, "job.confidential_view"), eq(auditLog.entityId, job.id), eq(auditLog.actorUserId, assigned.userId)));
    expect(after).toHaveLength(before.length + 1);
  });

  test("a new release schedule never gives it a release date, and a copy stays confidential", async () => {
    await f.run((tx) => recomputeReleaseDates(tx, { releaseDayOfMonth: 3, releaseTime: "08:00" }));
    const [row] = await get().db.select().from(jobs).where(eq(jobs.id, job.id));
    expect(row.releaseAt).toBeNull();
    const { jobs: copies } = await f.run((tx) => copyJob(f.coord, tx, job.id, { kind: "dates", dates: ["2035-07-11"] }, { now: NOW }));
    expect(copies[0]).toMatchObject({ confidential: true, releaseAt: null });
    expect(ids(await f.run((tx) => listJobs(deputy, tx, RANGE, 1)))).not.toContain(copies[0].id);
  });
});
