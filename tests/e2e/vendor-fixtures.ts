/**
 * Data for the vendor portal suite, written straight to the e2e database before the app starts. The e2e vendor
 * login (Pat Morgan) belongs to Lakeview Community; nothing here touches the other suites' vendors.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import { assignments, invoiceEvents, invoices, jobPositions, jobs, jobTypes, positionTypes, ranks, users, vendorDocuments, vendorLocations, vendors } from "@/db/schema";
import { agencyDateParts, agencyDayKey, agencyInstant } from "@/domain/time/agency-time";

export const VENDOR = {
  name: "Lakeview Community",
  location: "Lakeview Town Center",
  address: "174 Lakeview Blvd E, Gulf Haven, FL 32400",
  filledJob: "Town Center gate, tomorrow",
  invoicedJob: "Farmers market lot",
  deputy: { email: "avery.harmon@e2e.test", name: "Avery Harmon", phone: "850-555-0177" },
  contract: "2026 detail agreement",
  /**
   * Fixed months for the calendar layout check, whatever today is: March 2031 spans six weeks, February 2032 five
   * (it starts on a Sunday), and November 2031 holds long names in every column.
   */
  calendarMonths: ["2031-03", "2031-11", "2032-02"],
} as const;

/** Long names, like a vendor's full legal name in a title, on every weekday of a fixed month's busiest week. */
const LONG_TITLES = [
  "Lakeview Community Association Annual Homeowners Meeting and Board Election",
  "Gulf Haven Farmers Market and Artisan Fair, North Parking Lot Traffic Control",
  "Harborfront Interfaith Chapel Christmas Eve Candlelight Service Overflow Parking",
];

const HOUR = 3_600_000;

function at(days: number, hour: number, minute = 0): Date {
  const p = agencyDateParts(new Date());
  return agencyInstant(p.year, p.month, p.day + days, hour, minute);
}

export async function seedVendor(db: Db): Promise<void> {
  const [vendor] = await db.select().from(vendors).where(eq(vendors.name, VENDOR.name));
  await db.update(vendors).set({ billingEmails: ["office@lakeview.example"], defaultRateCents: 6500 }).where(eq(vendors.id, vendor.id));
  const [rank] = await db.select().from(ranks).where(eq(ranks.name, "Deputy Sheriff"));
  const [type] = await db.select().from(jobTypes).limit(1);
  const [sheriff] = await db.select().from(positionTypes).where(eq(positionTypes.name, "Deputy Sheriff"));
  const [avery] = await db
    .insert(users)
    .values({ ...VENDOR.deputy, emailVerified: true, role: "personnel", rankId: rank.id, mailingAddress: "PO Box 12, Gulf Haven, FL 32400" })
    .returning();
  const [loc] = await db.insert(vendorLocations).values({ vendorId: vendor.id, name: VENDOR.location, address: VENDOR.address, lat: 29.3712, lng: -82.2244 }).returning();
  await db.insert(vendorDocuments).values({ vendorId: vendor.id, kind: "contract", label: VENDOR.contract, url: "https://sign.example/lakeview-2026", signedOn: agencyDayKey(at(-60, 12)), expiresOn: agencyDayKey(at(300, 12)) });

  const job = async (values: Omit<typeof jobs.$inferInsert, "typeId" | "vendorId" | "rateCents">) => {
    const [j] = await db.insert(jobs).values({ state: "scheduled", releaseAt: new Date(Date.now() - 48 * HOUR), typeId: type.id, vendorId: vendor.id, locationId: loc.id, rateCents: 6500, ...values }).returning();
    const [p] = await db.insert(jobPositions).values({ jobId: j.id, positionTypeId: sheriff.id, count: 1 }).returning();
    return { job: j, positionId: p.id };
  };

  // Filled and inside the 24-hour edit lock.
  const filled = await job({ title: VENDOR.filledJob, startAt: new Date(Date.now() + 20 * HOUR), endAt: new Date(Date.now() + 24 * HOUR) });
  await db.insert(assignments).values({ jobId: filled.job.id, jobPositionId: filled.positionId, userId: avery.id, status: "signed_up", plannedStartAt: filled.job.startAt, plannedEndAt: filled.job.endAt });

  // Worked last week, billed and sent to the vendor.
  const worked = await job({ title: VENDOR.invoicedJob, startAt: at(-6, 7), endAt: at(-6, 11) });
  const [a] = await db
    .insert(assignments)
    .values({ jobId: worked.job.id, jobPositionId: worked.positionId, userId: avery.id, status: "billed", billedAt: at(-6, 12), plannedStartAt: worked.job.startAt, plannedEndAt: worked.job.endAt, actualStartAt: worked.job.startAt, actualEndAt: worked.job.endAt })
    .returning();
  const [inv] = await db
    .insert(invoices)
    .values({ assignmentId: a.id, vendorId: vendor.id, payeeUserId: avery.id, minutes: 240, rateCents: 6500, totalCents: 26000, status: "sent", sentAt: at(-5, 9), emailStatus: "sent", responsibleParty: "vendor", responsibleSince: at(-5, 9) })
    .returning();
  await db.insert(invoiceEvents).values({ invoiceId: inv.id, event: "sent", party: "vendor", vendorVisible: true, at: at(-5, 9) });

  // The calendar months: the first and last days, and a full week with three long titles a day.
  for (const month of VENDOR.calendarMonths) {
    const [y, m] = month.split("-").map(Number);
    const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
    const days = [1, 2, 22, 23, 24, 25, 26, 27, 28, last];
    for (const d of days) {
      for (const [i, title] of LONG_TITLES.entries()) {
        await job({ title, startAt: agencyInstant(y, m, d, 8 + i * 4, 0), endAt: agencyInstant(y, m, d, 11 + i * 4, 0) });
      }
    }
  }
}
