import { beforeAll, describe, expect, test } from "vitest";
import { and, eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, auditLog, deputyNotes, jobs, notifications, users, vendorLocations } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, ValidationError } from "@/domain/errors";
import { deputyNotesForJob, editDeputyNote, retireDeputyNote, reviewDeputyNote, submitDeputyNote } from "@/domain/deputy-notes/deputy-notes";
import { getJob } from "@/domain/jobs/jobs";
import { DEFAULT_CHANNELS } from "@/domain/notifications/types";
import { vendorViewJob } from "@/domain/vendor-portal/requests";

const DAY = 24 * 3_600_000;

describe("deputy notes", () => {
  const get = useTestDb();
  useEmailQueue(get);
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let author: Actor;
  let locA: string;
  let locB: string;
  const run = <T>(fn: (tx: Parameters<Parameters<ReturnType<typeof get>["db"]["transaction"]>[0]>[0]) => Promise<T>) => get().db.transaction(fn);
  const inbox = (userId: string, type: string) =>
    get().db.select().from(notifications).where(and(eq(notifications.userId, userId), eq(notifications.type, type)));
  const after = (job: { startAt: Date }) => new Date(job.startAt.getTime() + 3_600_000);

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "dn");
    admin = (await makeUser(db, "admin", "dn-admin@example.test")).actor;
    author = await fx.person();
    await db.update(users).set({ name: "Dana Reyes" }).where(eq(users.id, author.userId));
    [{ id: locA }] = await db.insert(vendorLocations).values({ vendorId: fx.vendorId, name: "North School" }).returning({ id: vendorLocations.id });
    [{ id: locB }] = await db.insert(vendorLocations).values({ vendorId: fx.vendorId, name: "South School" }).returning({ id: vendorLocations.id });
  });

  /** A job for the fixture vendor (optionally at a location) with `who` signed up, or the given status. */
  async function mkJobFor(who: Actor | null, o: { locationId?: string | null; vendor?: string; status?: "signed_up" | "billed" | "paid" | "canceled" } = {}) {
    const { job, positionId } = await fx.mkJob({ vendor: o.vendor });
    if (o.locationId) await get().db.update(jobs).set({ locationId: o.locationId }).where(eq(jobs.id, job.id));
    if (who) await get().db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: who.userId, status: o.status ?? "signed_up" });
    return (await get().db.select().from(jobs).where(eq(jobs.id, job.id)))[0];
  }
  const submit = (a: Actor, jobId: string, body: string, scope: "vendor" | "location", now: Date) =>
    run((tx) => submitDeputyNote(a, tx, { jobId, body, scope }, now));
  const notesFor = (a: Actor, jobId: string) => run((tx) => deputyNotesForJob(a, tx, jobId));

  test("default channels", () => {
    expect(DEFAULT_CHANNELS["deputyNote.submitted"]).toEqual({ email: true, push: false });
    expect(DEFAULT_CHANNELS["deputyNote.approved"]).toEqual({ email: false, push: true });
    expect(DEFAULT_CHANNELS["deputyNote.denied"]).toEqual({ email: false, push: true });
  });

  test("only a person signed up, billed or paid on the job may submit, and only once it has started", async () => {
    const job = await mkJobFor(author);
    const stranger = await fx.person();
    await expect(submit(stranger, job.id, "Gate code is 1234", "vendor", after(job))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submit(fx.coord, job.id, "Gate code is 1234", "vendor", after(job))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(submit(author, job.id, "Gate code is 1234", "vendor", new Date(job.startAt.getTime() - 1))).rejects.toBeInstanceOf(ValidationError);
    const canceled = await mkJobFor(author, { status: "canceled" });
    await expect(submit(author, canceled.id, "Gate code is 1234", "vendor", after(canceled))).rejects.toBeInstanceOf(ForbiddenError);
    for (const status of ["billed", "paid"] as const) {
      const j = await mkJobFor(author, { status });
      expect((await submit(author, j.id, "Park behind the gym", "vendor", after(j))).status).toBe("pending");
    }
    expect(await get().db.select().from(deputyNotes).where(eq(deputyNotes.submittedBy, stranger.userId))).toHaveLength(0);
  });

  test("body is trimmed and must be 1 to 2,000 characters; a location scope needs a job location", async () => {
    const job = await mkJobFor(author, { locationId: locA });
    await expect(submit(author, job.id, "   ", "vendor", after(job))).rejects.toBeInstanceOf(ValidationError);
    await expect(submit(author, job.id, "x".repeat(2001), "vendor", after(job))).rejects.toBeInstanceOf(ValidationError);
    expect((await submit(author, job.id, "x".repeat(2000), "vendor", after(job))).body).toHaveLength(2000);
    expect((await submit(author, job.id, "  Use the side door.  ", "location", after(job))).body).toBe("Use the side door.");
    const noLoc = await mkJobFor(author);
    await expect(submit(author, noLoc.id, "No place", "location", after(noLoc))).rejects.toBeInstanceOf(ValidationError);
  });

  test("scope must be vendor or location; decision must be approve or deny; comment is capped", async () => {
    const job = await mkJobFor(author, { locationId: locA });
    for (const scope of ["", "Location", undefined, "all"]) {
      await expect(run((tx) => submitDeputyNote(author, tx, { jobId: job.id, body: "Scope check", scope: scope as never }, after(job)))).rejects.toBeInstanceOf(ValidationError);
    }
    const note = await submit(author, job.id, "Decision check", "vendor", after(job));
    for (const decision of ["", "approved", "Deny", undefined]) {
      await expect(run((tx) => reviewDeputyNote(fx.coord, tx, note.id, { decision: decision as never }))).rejects.toBeInstanceOf(ValidationError);
    }
    await expect(run((tx) => reviewDeputyNote(fx.coord, tx, note.id, { decision: "deny", comment: "x".repeat(2001) }))).rejects.toBeInstanceOf(ValidationError);
    expect((await get().db.select().from(deputyNotes).where(eq(deputyNotes.id, note.id)))[0].status).toBe("pending");
    expect((await run((tx) => reviewDeputyNote(fx.coord, tx, note.id, { decision: "deny", comment: "x".repeat(2000) }))).status).toBe("denied");
  });

  test("submitting alerts coordinators, is audited, and a pending note shows on no job", async () => {
    const job = await mkJobFor(author);
    const note = await submit(author, job.id, "Ask for Mr. Boudreau at the front desk.", "vendor", after(job));
    expect(note).toMatchObject({ vendorId: fx.vendorId, locationId: null, status: "pending", submittedBy: author.userId, submittedFromJobId: job.id });
    expect((await inbox(fx.coord.userId, "deputyNote.submitted")).length).toBeGreaterThan(0);
    expect((await get().db.select().from(auditLog).where(eq(auditLog.entityId, note.id))).map((r) => r.action)).toContain("deputy_note.submit");
    expect((await notesFor(author, job.id)).map((n) => n.body)).not.toContain(note.body);
    expect((await notesFor(fx.coord, job.id)).map((n) => n.body)).not.toContain(note.body);
  });

  test("approval with an edited body shows on every current and future job for the vendor; location notes only at that location", async () => {
    const src = await mkJobFor(author, { locationId: locA });
    const vendorNote = await submit(author, src.id, "raw wording", "vendor", after(src));
    const locNote = await submit(author, src.id, "North only: lock the east gate.", "location", after(src));
    const atA = await mkJobFor(null, { locationId: locA });
    const atB = await mkJobFor(null, { locationId: locB });
    const noLoc = await mkJobFor(null);
    const otherVendor = await mkJobFor(null, { vendor: fx.otherVendorId });

    await run((tx) => reviewDeputyNote(fx.coord, tx, vendorNote.id, { decision: "approve", editedBody: "  Clean wording.  " }));
    await run((tx) => reviewDeputyNote(admin, tx, locNote.id, { decision: "approve" }));
    expect(await inbox(author.userId, "deputyNote.approved")).toHaveLength(2);

    const bodies = async (id: string) => (await notesFor(author, id)).map((n) => n.body);
    expect(await bodies(atA.id)).toEqual(["North only: lock the east gate.", "Clean wording."]);
    expect(await bodies(atB.id)).toEqual(["Clean wording."]);
    expect(await bodies(noLoc.id)).toEqual(["Clean wording."]);
    expect(await bodies(otherVendor.id)).toEqual([]);
    const future = await mkJobFor(null, { locationId: locB });
    expect(await bodies(future.id)).toEqual(["Clean wording."]);

    const [first] = await notesFor(fx.coord, atA.id);
    expect(first).toEqual({ body: "North only: lock the east gate.", authorName: "Dana Reyes", writtenAt: expect.any(Date) });
    expect(first.writtenAt).toEqual(locNote.submittedAt);
    const audit = (await get().db.select().from(auditLog).where(eq(auditLog.entityId, vendorNote.id))).find((r) => r.action === "deputy_note.review")!;
    expect(audit.before).toMatchObject({ status: "pending", body: "raw wording" });
    expect(audit.after).toMatchObject({ status: "approved", body: "Clean wording." });
  });

  test("ordering: location notes first, then vendor-wide, newest written first within each", async () => {
    const v = (await get().db.insert((await import("@/db/schema")).vendors).values({ name: "dn Ordering Vendor", defaultRateCents: 7000 }).returning())[0];
    const [loc] = await get().db.insert(vendorLocations).values({ vendorId: v.id, name: "Order School" }).returning();
    const src = await mkJobFor(author, { vendor: v.id, locationId: loc.id });
    const t0 = after(src);
    const mk = async (body: string, scope: "vendor" | "location", dayOffset: number) => {
      const n = await submit(author, src.id, body, scope, new Date(t0.getTime() + dayOffset * DAY));
      await run((tx) => reviewDeputyNote(fx.coord, tx, n.id, { decision: "approve" }));
    };
    await mk("vendor old", "vendor", 0);
    await mk("loc old", "location", 1);
    await mk("vendor new", "vendor", 2);
    await mk("loc new", "location", 3);
    expect((await notesFor(fx.coord, src.id)).map((n) => n.body)).toEqual(["loc new", "loc old", "vendor new", "vendor old"]);
  });

  test("a denied note never shows and the author is alerted with the reason; reviewing needs a coordinator and a pending note", async () => {
    const job = await mkJobFor(author);
    const note = await submit(author, job.id, "Denied wording", "vendor", after(job));
    await expect(run((tx) => reviewDeputyNote(author, tx, note.id, { decision: "approve" }))).rejects.toBeInstanceOf(ForbiddenError);
    const before = (await inbox(author.userId, "deputyNote.denied")).length;
    const done = await run((tx) => reviewDeputyNote(fx.coord, tx, note.id, { decision: "deny", comment: "Not appropriate." }));
    expect(done).toMatchObject({ status: "denied", reviewedBy: fx.coord.userId, reviewComment: "Not appropriate." });
    const rows = await inbox(author.userId, "deputyNote.denied");
    expect(rows).toHaveLength(before + 1);
    expect(rows.map((r) => r.body)).toContain("Your deputy note was not approved. Reason: Not appropriate.");
    const plain = await submit(author, job.id, "Denied without a reason", "vendor", after(job));
    await run((tx) => reviewDeputyNote(fx.coord, tx, plain.id, { decision: "deny" }));
    expect((await inbox(author.userId, "deputyNote.denied")).map((r) => r.body)).toContain("Your deputy note was not approved.");
    expect((await notesFor(fx.coord, job.id)).map((n) => n.body)).not.toContain("Denied wording");
    await expect(run((tx) => reviewDeputyNote(fx.coord, tx, note.id, { decision: "approve" }))).rejects.toBeInstanceOf(ValidationError);
  });

  test("edit keeps the author and written date and is audited; retire stops showing and keeps history", async () => {
    const job = await mkJobFor(author);
    const note = await submit(author, job.id, "Original", "vendor", after(job));
    await run((tx) => reviewDeputyNote(fx.coord, tx, note.id, { decision: "approve" }));
    await expect(run((tx) => editDeputyNote(author, tx, note.id, { body: "Mine now" }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => editDeputyNote(fx.coord, tx, note.id, { body: " " }))).rejects.toBeInstanceOf(ValidationError);
    const edited = await run((tx) => editDeputyNote(admin, tx, note.id, { body: "Edited later" }));
    expect(edited).toMatchObject({ body: "Edited later", submittedBy: author.userId });
    expect(edited.submittedAt).toEqual(note.submittedAt);
    const [shown] = await notesFor(fx.coord, job.id);
    expect(shown).toMatchObject({ body: "Edited later", authorName: "Dana Reyes", writtenAt: note.submittedAt });
    const edit = (await get().db.select().from(auditLog).where(eq(auditLog.entityId, note.id))).find((r) => r.action === "deputy_note.edit")!;
    expect(edit.before).toMatchObject({ body: "Original" });
    expect(edit.after).toMatchObject({ body: "Edited later" });

    await expect(run((tx) => retireDeputyNote(author, tx, note.id))).rejects.toBeInstanceOf(ForbiddenError);
    const retired = await run((tx) => retireDeputyNote(fx.coord, tx, note.id));
    expect(retired.status).toBe("retired");
    expect((await notesFor(fx.coord, job.id)).map((n) => n.body)).not.toContain("Edited later");
    expect(await get().db.select().from(deputyNotes).where(eq(deputyNotes.id, note.id))).toHaveLength(1);
    expect((await get().db.select().from(auditLog).where(eq(auditLog.entityId, note.id))).map((r) => r.action)).toContain("deputy_note.retire");
  });

  test("vendor actors are refused and never see deputy notes", async () => {
    const job = await mkJobFor(author);
    const note = await submit(author, job.id, "Secret wording for deputies", "vendor", after(job));
    await run((tx) => reviewDeputyNote(fx.coord, tx, note.id, { decision: "approve" }));
    const vendorActor: Actor = { userId: "x", role: "vendor", rankId: null, vendorId: fx.vendorId };
    await expect(notesFor(vendorActor, job.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect(JSON.stringify(await run((tx) => vendorViewJob(vendorActor, tx, job.id, new Date(0))))).not.toContain("Secret wording");
    const detail = await run((tx) => getJob(vendorActor, tx, job.id));
    expect(JSON.stringify(detail)).not.toContain("Secret wording");
    expect(Object.keys(detail)).not.toContain("deputyNotes");
  });
});
