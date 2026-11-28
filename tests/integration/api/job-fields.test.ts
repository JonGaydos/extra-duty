import { beforeAll, describe, expect, test } from "vitest";
import { eq } from "drizzle-orm";
import { bearer, call, sessionToken, useApiDb } from "./helpers";
import { makeUser } from "../users/helpers";
import { setupFixture } from "../assignments/helpers";
import { assignments, jobs, vendorManagers, vendorUsers } from "@/db/schema";
import { GET as listRoute } from "@/app/api/v1/jobs/route";
import { GET as getRoute } from "@/app/api/v1/jobs/[id]/route";

/**
 * Owner decision (Hourly rate range): an approved out-of-range rate is shown only in the audit log and on the
 * detail's staff page. Its reason, approver and time never reach personnel or vendors, through any API.
 */
describe("rate exception fields by role", () => {
  const get = useApiDb();
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let jobId: string;
  const tokens: Record<string, string> = {};
  const at = new Date("2035-01-05T15:00:00Z");

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "jf");
    const { job } = await f.mkJob();
    jobId = job.id;
    await db
      .update(jobs)
      .set({ rateCents: 9900, rateOverrideReason: "Holiday premium agreed with the sheriff", rateOverrideBy: f.coord.userId, rateOverrideAt: at, lateCancelWaivedReason: "Vendor paid in person" })
      .where(eq(jobs.id, jobId));
    tokens.coordinator = await sessionToken(db, f.coord.userId);
    tokens.admin = await sessionToken(db, (await makeUser(db, "admin", "jf-admin@example.test")).row.id);
    tokens.personnel = await sessionToken(db, (await f.person()).userId);
    const vendor = await makeUser(db, "vendor", "jf-vendor@example.test");
    await db.insert(vendorUsers).values({ userId: vendor.row.id, vendorId: f.vendorId });
    tokens.vendor = await sessionToken(db, vendor.row.id);
  });

  // A sign-in session sent as a bearer token, as the native app does: the same session a browser cookie carries.
  const headers = (role: string) => bearer(tokens[role]);
  const one = async (role: string) => {
    const res = await call(getRoute, `/api/v1/jobs/${jobId}`, { headers: headers(role), params: { id: jobId } });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()).data;
  };
  const listed = async (role: string) => {
    const res = await call(listRoute, "/api/v1/jobs?from=2035-01-01&to=2035-12-31", { headers: headers(role) });
    expect(res.status, await res.clone().text()).toBe(200);
    const row = (await res.json()).data.find((j: { id: string }) => j.id === jobId);
    expect(row).toBeTruthy();
    return row;
  };
  const hidden = { rateOverrideReason: null, rateOverrideBy: null, rateOverrideAt: null, lateCancelWaivedReason: null };

  test.each(["coordinator", "admin"])("%s sees the rate exception on the detail and in the list", async (role) => {
    const shown = { rateOverrideReason: "Holiday premium agreed with the sheriff", rateOverrideBy: f.coord.userId, rateOverrideAt: at.toISOString(), lateCancelWaivedReason: "Vendor paid in person" };
    expect(await one(role)).toMatchObject(shown);
    expect(await listed(role)).toMatchObject(shown);
  });

  test.each(["personnel", "vendor"])("%s never gets the rate exception, on the detail or in the list", async (role) => {
    for (const body of [await one(role), await listed(role)]) {
      expect(body).toMatchObject(hidden);
      expect(body.rateCents).toBe(9900);
      expect(JSON.stringify(body)).not.toContain("Holiday premium");
    }
  });
});

/**
 * The detail's reminder note goes to the people assigned. Only staff, managers of that vendor and the assigned
 * people see it; vendors and anyone else never get it, on the detail or in the list.
 */
describe("reminder note by role", () => {
  const get = useApiDb();
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let jobId: string;
  const tokens: Record<string, string> = {};
  const NOTE = "Park behind the gym, gate code with the custodian";

  beforeAll(async () => {
    const { db } = get();
    f = await setupFixture(db, "rn");
    const { job, positionId } = await f.mkJob();
    jobId = job.id;
    await db.update(jobs).set({ reminderNote: NOTE }).where(eq(jobs.id, jobId));
    tokens.coordinator = await sessionToken(db, f.coord.userId);
    tokens.personnel = await sessionToken(db, (await f.person()).userId);
    const onIt = await f.person();
    await db.insert(assignments).values({ jobId, jobPositionId: positionId, userId: onIt.userId, status: "signed_up" });
    tokens.assigned = await sessionToken(db, onIt.userId);
    const manager = await f.person();
    await db.insert(vendorManagers).values({ userId: manager.userId, vendorId: f.vendorId });
    tokens.manager = await sessionToken(db, manager.userId);
    const vendor = await makeUser(db, "vendor", "rn-vendor@example.test");
    await db.insert(vendorUsers).values({ userId: vendor.row.id, vendorId: f.vendorId });
    tokens.vendor = await sessionToken(db, vendor.row.id);
  });

  const one = async (role: string) => {
    const res = await call(getRoute, `/api/v1/jobs/${jobId}`, { headers: bearer(tokens[role]), params: { id: jobId } });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()).data;
  };
  const listed = async (role: string) => {
    const res = await call(listRoute, "/api/v1/jobs?from=2035-01-01&to=2035-12-31", { headers: bearer(tokens[role]) });
    expect(res.status, await res.clone().text()).toBe(200);
    return (await res.json()).data.find((j: { id: string }) => j.id === jobId);
  };

  test.each(["coordinator", "manager", "assigned"])("%s sees the reminder note on the detail", async (role) => {
    expect((await one(role)).reminderNote).toBe(NOTE);
  });

  test.each(["vendor", "personnel"])("%s never gets the reminder note, on the detail or in the list", async (role) => {
    expect((await one(role)).reminderNote).toBeNull();
    const row = await listed(role);
    if (row) expect(JSON.stringify(row)).not.toContain("gate code");
  });
});
