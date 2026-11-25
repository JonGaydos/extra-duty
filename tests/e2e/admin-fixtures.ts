/**
 * Data for the Management and System suite, written straight to the e2e database before the app starts. Nothing
 * here touches the coordinator or personnel suites' rows.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { assignments, jobPositions, jobs, jobTypes, positionTypes, qualificationRequests, qualifications, ranks, userQualifications, users, vendors, vendorUsers } from "@/db/schema";
import { releaseAt } from "@/domain/release/release";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";

export const ADMIN = {
  suspend: { email: "casey@e2e.test", name: "Casey Suspend" },
  flagged: { email: "quinn@e2e.test", name: "Quinn Flagged" },
  holder: { email: "harper@e2e.test", name: "Harper Holder" },
  reviewee: { email: "rowan@e2e.test", name: "Rowan Review" },
  vendor: "Grayton Beach Market",
  releaseJob: "Market night, release check",
  requestedFlag: "K9",
  heldFlag: "Motors",
  /** A vendor with its own login and a scheduled detail, for the notification switch test. */
  notifyVendor: "Harborfront Notify Co",
  notifyLogin: { email: "noel.notify@e2e.test", name: "Noel Notify" },
  notifyJob: "Harborfront lot watch, notification check",
  /** A deputy who leaves: two upcoming sign-ups and one worked detail not billed yet. */
  leaver: { email: "lane.leaving@e2e.test", name: "Lane Leaving" },
  leaverJobs: ["Market lot, leaver one", "Market lot, leaver two"],
  leaverWorked: "Market lot, leaver worked",
} as const;

export async function seedAdmin(db: Db): Promise<void> {
  const [rank] = await db.select().from(ranks).where(eq(ranks.name, "Deputy Sheriff"));
  const quals = Object.fromEntries((await db.select().from(qualifications)).map((q) => [q.name, q.id]));
  const made: Record<string, string> = {};
  for (const key of ["suspend", "flagged", "holder", "reviewee"] as const) {
    const [u] = await db
      .insert(users)
      .values({ ...ADMIN[key], emailVerified: true, role: "personnel", rankId: rank.id })
      .returning();
    made[key] = u.id;
  }
  await db.insert(qualificationRequests).values({ userId: made.flagged, qualificationId: quals[ADMIN.requestedFlag], note: "Handler course finished in September." });
  await db.insert(userQualifications).values({ userId: made.holder, qualificationId: quals[ADMIN.heldFlag] });

  // A detail about 100 days out: its release date is still ahead, so a release day change moves it.
  const p = agencyDateParts(new Date());
  const startAt = agencyInstant(p.year, p.month + 3, 10, 18, 0);
  const endAt = agencyInstant(p.year, p.month + 3, 10, 22, 0);
  const [type] = await db.select().from(jobTypes).limit(1);
  const [pos] = await db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
  const [vendor] = await db.insert(vendors).values({ name: ADMIN.vendor, billingEmails: ["office@market.example", "books@market.example"], defaultRateCents: 6500, contactName: "John Smith", phone: "8505550148" }).returning();
  const [job] = await db
    .insert(jobs)
    .values({ vendorId: vendor.id, typeId: type.id, title: ADMIN.releaseJob, startAt, endAt, rateCents: 6500, state: "scheduled", releaseAt: releaseAt(startAt, { releaseDayOfMonth: 15, releaseTime: "16:00" }) })
    .returning();
  await db.insert(jobPositions).values({ jobId: job.id, positionTypeId: pos.id, count: 2 });

  const [nv] = await db.insert(vendors).values({ name: ADMIN.notifyVendor, billingEmails: ["office@harborfront.example"], defaultRateCents: 6500 }).returning();
  const [login] = await db.insert(users).values({ ...ADMIN.notifyLogin, emailVerified: true, role: "vendor" }).returning();
  await db.insert(vendorUsers).values({ userId: login.id, vendorId: nv.id });
  const [nj] = await db
    .insert(jobs)
    .values({ vendorId: nv.id, typeId: type.id, title: ADMIN.notifyJob, startAt: agencyInstant(p.year, p.month + 3, 12, 18, 0), endAt: agencyInstant(p.year, p.month + 3, 12, 22, 0), rateCents: 6500, state: "scheduled", releaseAt: new Date("2000-01-01") })
    .returning();
  await db.insert(jobPositions).values({ jobId: nj.id, positionTypeId: pos.id, count: 1 });

  const [leaver] = await db
    .insert(users)
    .values({ ...ADMIN.leaver, emailVerified: true, role: "personnel", rankId: rank.id, mailingAddress: "12 Gulf Ave, Bayside, FL 32400" })
    .returning();
  const signedUp = async (title: string, startAt: Date) => {
    const [j] = await db
      .insert(jobs)
      .values({ vendorId: vendor.id, typeId: type.id, title, startAt, endAt: new Date(startAt.getTime() + 4 * 3_600_000), rateCents: 6500, state: "scheduled", releaseAt: new Date("2000-01-01") })
      .returning();
    const [jp] = await db.insert(jobPositions).values({ jobId: j.id, positionTypeId: pos.id, count: 1 }).returning();
    await db.insert(assignments).values({ jobId: j.id, jobPositionId: jp.id, userId: leaver.id, status: "signed_up" });
  };
  // Whole-minute times, as a coordinator would post them (the bill form compares to the minute).
  const today = agencyDateParts(new Date());
  const onDay = (offset: number) => agencyInstant(today.year, today.month, today.day + offset, 18, 0);
  await signedUp(ADMIN.leaverJobs[0], onDay(10));
  await signedUp(ADMIN.leaverJobs[1], onDay(17));
  await signedUp(ADMIN.leaverWorked, onDay(-4));
}
