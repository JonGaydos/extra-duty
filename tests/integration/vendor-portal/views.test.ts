import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import type { Tx } from "@/db/client";
import { setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, invoices, jobChangeRequests, jobs, paymentMethods, positionTypes, users, vendorLocations, vendorUsers } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { ForbiddenError, NotFoundError } from "@/domain/errors";
import { updateSettings } from "@/domain/settings/settings";
import { vendorDetails, vendorInvoices, vendorJobControls, vendorRequestOptions } from "@/domain/vendor-portal/views";
import { vendorViewJob } from "@/domain/vendor-portal/requests";

const HOUR = 3_600_000;

describe("vendor portal views", () => {
  const get = useTestDb();
  let fx: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let vendorUser: Actor;
  let person: Actor;

  const run = <T>(fn: (tx: Tx) => Promise<T>) => get().db.transaction(fn);
  const at = (h: number) => new Date(Date.now() + h * HOUR);

  /** A job for `vendorId` starting `h` hours from now, one Deputy Sheriff position of `count`. */
  async function job(h: number, o: { vendorId?: string; state?: "requested" | "scheduled" | "canceled" | "declined"; count?: number; title?: string } = {}) {
    const { job: j, positionId } = await fx.mkJob({ vendor: o.vendorId ?? fx.vendorId, count: o.count ?? 1 });
    const [row] = await get()
      .db.update(jobs)
      .set({ startAt: at(h), endAt: at(h + 4), state: o.state ?? "scheduled", title: o.title ?? j.title })
      .where(eq(jobs.id, j.id))
      .returning();
    return { job: row, positionId };
  }

  beforeAll(async () => {
    const { db } = get();
    fx = await setupFixture(db, "vv");
    admin = (await makeUser(db, "admin", "vv-admin@example.test")).actor;
    const made = await makeUser(db, "vendor", "vv-vendor@example.test");
    vendorUser = { ...made.actor, vendorId: fx.vendorId };
    await db.insert(vendorUsers).values({ userId: made.row.id, vendorId: fx.vendorId });
    person = await fx.person();
    await db.update(users).set({ name: "Avery Harmon" }).where(eq(users.id, person.userId));
  });

  beforeEach(async () => {
    await run((tx) => updateSettings(admin, tx, { vendorEditLockHours: 24, vendorCancelUntilHours: 24, vendorEditsAfterSignup: "none", lateVendorCancelHours: 24 }));
  });

  test("lists only the vendor's own details with a status in words and a waiting change", async () => {
    const requested = await job(200, { state: "requested", title: "VV requested" });
    const open = await job(210, { count: 2, title: "VV open" });
    const filled = await job(220, { title: "VV filled" });
    await get().db.insert(assignments).values({ jobId: filled.job.id, jobPositionId: filled.positionId, userId: person.userId, status: "signed_up" });
    const past = await job(-30, { title: "VV past" });
    const canceled = await job(230, { state: "canceled", title: "VV canceled" });
    const other = await job(240, { vendorId: fx.otherVendorId, title: "VV other vendor" });
    await get().db.insert(jobChangeRequests).values({ jobId: open.job.id, requestedBy: vendorUser.userId, patch: { endAt: at(215).toISOString() } });

    const rows = await run((tx) => vendorDetails(vendorUser, tx, { from: at(-100), to: at(300) }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    expect(byId.has(other.job.id)).toBe(false);
    expect(byId.get(requested.job.id)?.status).toBe("requested");
    expect(byId.get(open.job.id)).toMatchObject({ status: "scheduled", needed: 2, filled: 0, pendingChange: true });
    expect(byId.get(filled.job.id)).toMatchObject({ status: "filled", needed: 1, filled: 1, pendingChange: false });
    expect(byId.get(past.job.id)?.status).toBe("past");
    expect(byId.get(canceled.job.id)?.status).toBe("canceled");
    expect(rows.map((r) => r.startAt.getTime())).toEqual([...rows.map((r) => r.startAt.getTime())].sort((a, b) => a - b));
  });

  test("the list and the detail agree on filled: a pending short request or a no-show does not fill a spot", async () => {
    for (const status of ["pending_short", "no_show"] as const) {
      const j = await job(status === "pending_short" ? 250 : 260, { title: `VV ${status}` });
      await get().db.insert(assignments).values({ jobId: j.job.id, jobPositionId: j.positionId, userId: person.userId, status });
      const rows = await run((tx) => vendorDetails(vendorUser, tx, { from: at(-100), to: at(300) }));
      const row = rows.find((r) => r.id === j.job.id)!;
      const detail = await run((tx) => vendorViewJob(vendorUser, tx, j.job.id));
      expect(row.filled, status).toBe(0);
      expect(row.status, status).not.toBe("filled");
      expect(detail.positions[0].filled, status).toBe(0);
    }
  });

  test("only vendor users read the vendor lists", async () => {
    await expect(run((tx) => vendorDetails(fx.coord, tx, { from: at(-1), to: at(1) }))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => vendorInvoices(person, tx))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(run((tx) => vendorRequestOptions(person, tx))).rejects.toBeInstanceOf(ForbiddenError);
  });

  test("edits are locked inside the edit lock setting with the reason, and time changes need approval outside it", async () => {
    const soon = await job(20);
    const locked = await run((tx) => vendorJobControls(vendorUser, tx, soon.job.id));
    expect(locked.edit).toEqual({ allowed: false, reason: "Changes are not allowed within 24 hours of the start. Call the coordinators." });
    expect(locked.cancel.allowed).toBe(false);
    expect(locked.cancel.reason).toBe("Cancellations close 24 hours before the start. Call the coordinators.");

    const later = await job(100);
    const open = await run((tx) => vendorJobControls(vendorUser, tx, later.job.id));
    expect(open.edit).toEqual({ allowed: true, reason: null });
    expect(open.schedule).toEqual({ allowed: true, needsApproval: true, reason: null, positionsOnly: false });
    expect(open.cancel).toMatchObject({ allowed: true, latePay: false });
    expect(open.positions).toEqual([{ positionTypeId: fx.pos["Deputy Sheriff"], name: "Deputy Sheriff", count: 1 }]);

    // The lock comes from the setting, not a fixed 24 hours.
    await run((tx) => updateSettings(admin, tx, { vendorEditLockHours: 120 }));
    const longer = await run((tx) => vendorJobControls(vendorUser, tx, later.job.id));
    expect(longer.edit.reason).toBe("Changes are not allowed within 120 hours of the start. Call the coordinators.");
  });

  test("a request waiting for approval changes in place and shows the waiting change", async () => {
    const req = await job(100, { state: "requested" });
    const c = await run((tx) => vendorJobControls(vendorUser, tx, req.job.id));
    expect(c.schedule).toEqual({ allowed: true, needsApproval: false, reason: null, positionsOnly: false });
    expect(c.pendingChange).toBeNull();
    const sched = await job(110);
    await get().db.insert(jobChangeRequests).values({ jobId: sched.job.id, requestedBy: vendorUser.userId, patch: {} });
    expect((await run((tx) => vendorJobControls(vendorUser, tx, sched.job.id))).pendingChange).not.toBeNull();
  });

  test("cancel inside the late window says late cancellation pay applies when someone is signed up", async () => {
    await run((tx) => updateSettings(admin, tx, { vendorCancelUntilHours: 2, lateVendorCancelHours: 24 }));
    const j = await job(10);
    await get().db.insert(assignments).values({ jobId: j.job.id, jobPositionId: j.positionId, userId: person.userId, status: "signed_up" });
    const c = await run((tx) => vendorJobControls(vendorUser, tx, j.job.id));
    expect(c.cancel).toMatchObject({ allowed: true, latePay: true, lateHours: 24 });
  });

  test("another vendor's job is not found", async () => {
    const other = await job(100, { vendorId: fx.otherVendorId });
    await expect(run((tx) => vendorJobControls(vendorUser, tx, other.job.id))).rejects.toBeInstanceOf(NotFoundError);
  });

  test("request options offer only the vendor's active locations and requestable positions", async () => {
    const { db } = get();
    await db.insert(vendorLocations).values([
      { vendorId: fx.vendorId, name: "VV Main", address: "1 Main St" },
      { vendorId: fx.vendorId, name: "VV Closed", address: "2 Main St", active: false },
      { vendorId: fx.otherVendorId, name: "VV Elsewhere", address: "3 Main St" },
    ]);
    await db.update(positionTypes).set({ vendorRequestable: false }).where(eq(positionTypes.name, "Dispatcher"));
    const o = await run((tx) => vendorRequestOptions(vendorUser, tx));
    expect(o.locations.map((l) => l.name)).toEqual(["VV Main"]);
    expect(o.positionTypes.map((p) => p.name)).not.toContain("Dispatcher");
    expect(o.positionTypes.map((p) => p.name)).toContain("Deputy Sheriff");
    expect(o.jobTypes.length).toBeGreaterThan(0);
    expect(o.rules).toMatchObject({ minNoticeHours: 72, editLockHours: 24, cancelUntilHours: 24, lateCancelHours: 24 });
  });

  test("invoices list only sent invoices for the vendor, with the vendor's own paid note", async () => {
    const { db } = get();
    const [ramp] = await db.select().from(paymentMethods).where(eq(paymentMethods.name, "Ramp"));
    const mk = async (vendorId: string, status: "sent" | "pending_review", sent: boolean) => {
      const j = await job(-50, { vendorId, title: `VV invoice ${status}` });
      const [a] = await db.insert(assignments).values({ jobId: j.job.id, jobPositionId: j.positionId, userId: person.userId, status: "billed" }).returning();
      const [inv] = await db
        .insert(invoices)
        .values({ assignmentId: a.id, vendorId, payeeUserId: person.userId, minutes: 240, rateCents: 6500, totalCents: 26000, status, sentAt: sent ? at(-40) : null })
        .returning();
      return inv;
    };
    const sent = await mk(fx.vendorId, "sent", true);
    await mk(fx.vendorId, "pending_review", false);
    await mk(fx.otherVendorId, "sent", true);
    await db.update(invoices).set({ vendorPaidAt: at(-1), vendorPaidMethodId: ramp.id, vendorPaidReference: "RMP-1" }).where(eq(invoices.id, sent.id));

    const rows = await run((tx) => vendorInvoices(vendorUser, tx));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: sent.id, payeeName: "Avery Harmon", totalCents: 26000, rateCents: 6500, status: "sent", jobTitle: "VV invoice sent" });
    expect(rows[0].number).toMatch(/\d+$/);
    expect(rows[0].vendorPaid).toMatchObject({ method: "Ramp", reference: "RMP-1" });
  });
});
