import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, beforeEach, describe, expect, test } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { useTestDb } from "../../setup/test-db";
import { useEmailQueue } from "../../setup/email-queue";
import { HOUR, setupFixture } from "../assignments/helpers";
import { makeUser } from "../users/helpers";
import { assignments, jobSeries, jobs as jobsTable, notifications, users, vendorLocations, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { billAssignment } from "@/domain/billing/bill";
import { editInvoice, sendBackInvoice } from "@/domain/invoices/review";
import { jobAudience } from "@/domain/notifications/audiences";
import { cancelJob, updateJob } from "@/domain/jobs/jobs";
import { recomputeReleaseDates } from "@/domain/release/release";
import { updateSettings } from "@/domain/settings/settings";
import { suspendUser } from "@/domain/users/suspension";
import { addVendorDocument, contractExpiryTick, createVendor } from "@/domain/vendors/vendors";
import { watchReleaseTick } from "@/jobs/backup-window";
import { agencyInstant } from "@/domain/time/agency-time";
import { setEmailSender } from "@/lib/email/sender";
import { createMemorySender } from "@/lib/email/types";

type Job = typeof jobsTable.$inferSelect;
const GOOD_EMAIL = { provider: "smtp" as const, from: "Sheriff <no-reply@sheriff.example>", smtp: { host: "smtp.test" } };
const AFTER = new Date("2036-01-01T00:00:00Z");

describe("automatic alert wiring", () => {
  const get = useTestDb();
  const { drain } = useEmailQueue(get);
  const mail = createMemorySender();
  let f: Awaited<ReturnType<typeof setupFixture>>;
  let admin: Actor;
  let bystander: Actor;

  beforeAll(async () => {
    const { db } = get();
    process.env.STORAGE_DRIVER = "local";
    process.env.STORAGE_LOCAL_DIR = await mkdtemp(join(tmpdir(), "extra-duty-wiring-"));
    f = await setupFixture(db, "wr");
    admin = (await makeUser(db, "admin", "wr-admin@example.test")).actor;
    bystander = await f.person();
    await db.update(vendors).set({ billingEmails: ["ap@vendor.example"] }).where(eq(vendors.id, f.vendorId));
  });

  beforeEach(() => {
    mail.clear();
    setEmailSender(mail);
  });

  const sorted = (ids: string[]) => [...ids].sort();
  /** Everyone who got a row of this type with this link. */
  const got = async (type: string, link: string) =>
    sorted((await get().db.select({ u: notifications.userId }).from(notifications).where(and(eq(notifications.type, type as never), eq(notifications.link, link)))).map((r) => r.u));
  const total = async () => (await get().db.select({ n: sql<number>`count(*)::int` }).from(notifications))[0].n;

  /** A job with one person in each live status, one canceled, one removed, plus the bystander. */
  async function staffed() {
    const { db } = get();
    const { job, positionId } = await f.mkJob({ count: 5 });
    const put = async (status: (typeof assignments.$inferInsert)["status"]) => {
      const p = await f.person();
      await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: p.userId, status });
      return p.userId;
    };
    const pending = await put("pending_short");
    const signed = await put("signed_up");
    const backup = await put("backup");
    await put("canceled");
    await put("removed");
    return { job, positionId, pending, signed, backup, audience: sorted([pending, signed, backup]), link: `/jobs/${job.id}` };
  }

  const update = (id: string, patch: Parameters<typeof updateJob>[3]) => f.run((tx) => updateJob(f.coord, tx, id, patch, "one"));

  test("jobAudience is pending, signed up and backup people, once each", async () => {
    const s = await staffed();
    expect(sorted(await f.run((tx) => jobAudience(tx, s.job)))).toEqual(s.audience);
    const empty = await f.mkJob();
    expect(await f.run((tx) => jobAudience(tx, empty.job))).toEqual([]);
  });

  test("a rate change reaches signed up, pending and backup people and nobody else", async () => {
    const s = await staffed();
    await update(s.job.id, { rateCents: 9000 });
    expect(await got("job.changed", s.link)).toEqual(s.audience);
    const rows = await get().db.select().from(notifications).where(and(eq(notifications.type, "job.changed"), eq(notifications.link, s.link)));
    expect(rows[0].body).toContain("$90.00");
    expect(await got("job.canceled", s.link)).toEqual([]);
  });

  test("a time change reaches the audience only, and the vendor and coordinators get nothing", async () => {
    const s = await staffed();
    await update(s.job.id, { startAt: new Date(s.job.startAt.getTime() + HOUR), endAt: new Date(s.job.endAt.getTime() + HOUR) });
    expect(await got("job.changed", s.link)).toEqual(s.audience);
    expect(await got("job.changed", s.link)).not.toContain(f.coord.userId);
  });

  test("a location change reaches the audience", async () => {
    const s = await staffed();
    const [loc] = await get().db.insert(vendorLocations).values({ vendorId: f.vendorId, name: "East gate", address: "1 Main St" }).returning();
    await update(s.job.id, { locationId: loc.id });
    expect(await got("job.changed", s.link)).toEqual(s.audience);
  });

  test("a change with no effect on people sends nothing", async () => {
    const s = await staffed();
    await update(s.job.id, { description: "Typo fixed", notes: "Bring a radio", title: "Stadium security detail", contactName: "Pat" });
    await update(s.job.id, { rateCents: s.job.rateCents });
    expect(await got("job.changed", s.link)).toEqual([]);
    expect(await got("job.safety_changed", s.link)).toEqual([]);
  });

  test("a rate change on a job nobody holds sends nothing", async () => {
    const { job } = await f.mkJob();
    const before = await total();
    await update(job.id, { rateCents: 9100 });
    expect(await total()).toBe(before);
  });

  test("a change in a series reaches each job's own audience", async () => {
    const { db } = get();
    const a = await staffed();
    const b = await staffed();
    const [{ id: seriesId }] = await db.insert(jobSeries).values({ name: "Wiring series" }).returning({ id: jobSeries.id });
    await db.update(jobsTable).set({ seriesId }).where(sql`${jobsTable.id} in (${a.job.id}, ${b.job.id})`);
    const first = a.job.startAt <= b.job.startAt ? a : b;
    const second = first === a ? b : a;
    await f.run((tx) => updateJob(f.coord, tx, first.job.id, { rateCents: 9200 }, "series"));
    expect(await got("job.changed", first.link)).toEqual(first.audience);
    expect(await got("job.changed", second.link)).toEqual(second.audience);
  });

  test("canceling a job reaches signed up, pending and backup people, once", async () => {
    const s = await staffed();
    await f.run((tx) => cancelJob(f.coord, tx, s.job.id, "Vendor canceled the event"));
    expect(await got("job.canceled", s.link)).toEqual(s.audience);
    expect(await got("job.changed", s.link)).toEqual([]);
  });

  test("an officer safety change reaches the audience; an identical save sends nothing", async () => {
    const s = await staffed();
    const safety = { notes: "Known fights near the east gate", addresses: [] };
    await update(s.job.id, { safety });
    expect(await got("job.safety_changed", s.link)).toEqual(s.audience);
    const n = await total();
    await update(s.job.id, { safety });
    expect(await total()).toBe(n);
  });

  test("the monthly release and a recompute send nothing", async () => {
    const { db } = get();
    const s = await staffed();
    // A detail in a future month, released on the 15th at 4:00 PM.
    const startAt = agencyInstant(2036, 3, 10, 17, 0);
    const release = agencyInstant(2036, 2, 15, 16, 0);
    await db.update(jobsTable).set({ startAt, endAt: new Date(startAt.getTime() + 6 * HOUR), state: "active", releaseAt: new Date(release.getTime() + 1) }).where(eq(jobsTable.id, s.job.id));
    const before = await total();
    await f.run((tx) => recomputeReleaseDates(tx, { releaseDayOfMonth: 15, releaseTime: "16:00" }));
    await f.run((tx) => watchReleaseTick(new Date(release.getTime() - 60_000), tx));
    await f.run((tx) => watchReleaseTick(new Date(release.getTime() + 60_000), tx));
    expect(await total()).toBe(before);
  });

  test("suspending a person alerts that person only", async () => {
    const target = await f.person();
    await f.run((tx) => suspendUser(f.coord, tx, target.userId, { reason: "Policy review", until: null, removeFutureAssignments: false }));
    const rows = await get().db.select().from(notifications).where(and(eq(notifications.type, "user.suspended"), sql`${notifications.body} like '%Policy review%'`));
    expect(rows.map((r) => r.userId)).toEqual([target.userId]);
  });

  describe("contract expiry reminders", () => {
    test("coordinators and admins get each threshold once, durably", async () => {
      const { db } = get();
      const v = await db.transaction((tx) =>
        createVendor(f.coord, tx, { name: "Reminder Co", typeId: null, contactName: "Pat", phone: "850-555-0155", billingEmails: ["a@example.test"], defaultRateCents: 4500, notes: null }),
      );
      await db.transaction((tx) => addVendorDocument(f.coord, tx, v.id, { kind: "contract", label: "Contract", url: "https://x.test/c", expiresOn: new Date("2037-03-01T18:00:00Z") }));
      const off = (await makeUser(db, "coordinator", "wr-off-coord@example.test")).row.id;
      await db.update(users).set({ active: false }).where(eq(users.id, off));
      const mine = async () => {
        const rows = await db.select().from(notifications).where(and(eq(notifications.type, "vendor.contract_expiring"), sql`${notifications.title} like '%Reminder Co%'`));
        return rows;
      };
      const staff = sorted((await db.select({ id: users.id }).from(users).where(sql`${users.active} and ${users.role} in ('coordinator','admin')`)).map((r) => r.id));
      const tick = (iso: string) => db.transaction((tx) => contractExpiryTick(tx, new Date(iso)));

      await tick("2036-12-30T18:00:00Z"); // 61 days
      expect(await mine()).toEqual([]);
      await tick("2036-12-31T18:00:00Z"); // 60 days
      expect(sorted((await mine()).map((r) => r.userId))).toEqual(staff);
      await tick("2036-12-31T20:00:00Z");
      await tick("2037-01-10T18:00:00Z");
      expect(await mine()).toHaveLength(staff.length);
      await tick("2037-01-30T18:00:00Z"); // 30 days
      expect(await mine()).toHaveLength(staff.length * 2);
      await tick("2037-01-31T18:00:00Z");
      await tick("2037-02-20T18:00:00Z");
      expect(await mine()).toHaveLength(staff.length * 2);
      const rows = await mine();
      expect(rows.some((r) => r.userId === off || r.userId === bystander.userId)).toBe(false);
      expect(rows.map((r) => r.title).join(" ")).toContain("60 days");
      expect(rows.map((r) => r.title).join(" ")).toContain("30 days");
    });
  });

  describe("billing and invoices", () => {
    beforeEach(async () => {
      await get().db.transaction((tx) =>
        updateSettings(admin, tx, { email: GOOD_EMAIL, billingReplyToEmail: "billing@sheriff.example", invoiceReviewMode: "all", minimumBillableMinutes: 240, hourRoundingMinutes: 15 }),
      );
      await drain();
      mail.clear();
    });

    async function bill(mode: "all" | "immediate") {
      const { db } = get();
      await db.transaction((tx) => updateSettings(admin, tx, { invoiceReviewMode: mode }));
      const person = await f.person();
      await db.update(users).set({ mailingAddress: "1 Main St, Town, TX 75001" }).where(eq(users.id, person.userId));
      const { job, positionId } = await f.mkJob();
      const [a] = await db.insert(assignments).values({ jobId: job.id, jobPositionId: positionId, userId: person.userId, status: "signed_up" }).returning();
      const r = await db.transaction((tx) => billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, AFTER));
      return { a, job: job as Job, person, inv: r.invoice };
    }
    const staff = async () => sorted((await get().db.select({ id: users.id }).from(users).where(sql`${users.active} and ${users.role} in ('coordinator','admin')`)).map((r) => r.id));

    test("an invoice held for review alerts coordinators and admins, not the biller", async () => {
      const { inv, person } = await bill("all");
      expect(await got("invoice.review_waiting", `/invoices/${inv.id}`)).toEqual(await staff());
      expect(await got("invoice.review_waiting", `/invoices/${inv.id}`)).not.toContain(person.userId);
    });

    test("an invoice sent without review alerts no one for review", async () => {
      const { inv } = await bill("immediate");
      expect(await got("invoice.review_waiting", `/invoices/${inv.id}`)).toEqual([]);
    });

    test("a re-billed invoice held again alerts coordinators again", async () => {
      const { inv, a, job, person } = await bill("all");
      await f.run((tx) => sendBackInvoice(f.coord, tx, inv.id, "Check the hours", AFTER));
      await get().db.transaction((tx) => billAssignment(person, tx, a.id, { startAt: job.startAt, endAt: job.endAt, attachW9: false }, AFTER));
      const rows = await get().db.select().from(notifications).where(and(eq(notifications.type, "invoice.review_waiting"), eq(notifications.link, `/invoices/${inv.id}`)));
      expect(rows).toHaveLength((await staff()).length * 2);
    });

    test("editing an invoice alerts the person who billed it, and nobody else", async () => {
      const { inv, job, person } = await bill("all");
      await f.run((tx) => editInvoice(f.coord, tx, inv.id, { rateCents: 8000, reason: "Rate corrected" }));
      expect(await got("invoice.edited", `/jobs/${job.id}`)).toEqual([person.userId]);
    });
  });
});
