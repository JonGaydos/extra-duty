/**
 * Data for the coordinator screens suite, written straight to the e2e database before the app starts. Times are
 * relative to now and set in agency time. Nothing here touches the personnel suite's rows.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  assignments,
  deputyNotes,
  invoiceEvents,
  invoices,
  jobPositions,
  jobs,
  jobTypes,
  opsPlans,
  paymentIssues,
  positionTypes,
  qualificationRequests,
  qualifications,
  ranks,
  users,
  vendorHolds,
  vendorLocations,
  vendors,
} from "@/db/schema";
import { updateSettings } from "@/domain/settings/settings";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";

export const COORD = {
  vendor: "Bayside County School Board",
  location: "Pine Harbor High School",
  address: "12615 US-1, Pine Harbor, FL 32401",
  heldVendor: "Lantern Events LLC",
  request: "Basketball, Pine Harbor High",
  lockedJob: "Lantern lot shift",
  approveInvoiceJob: "Church traffic, Sunday",
  /** Held for review; its vendor (the e2e vendor login's) is set to not get approved invoices by email. */
  unsentInvoiceJob: "Lakeview gate, approve without sending",
  unsentVendor: "Lakeview Community",
  sendBackInvoiceJob: "Parade route corner",
  issueJob: "Harborfront Arts July 4",
  opsJob: "Mardi Gras parade",
  unfilledJob: "Gym doors, early game",
  note: "Use the north gate after 6 PM; the south gate code changes weekly.",
  signed: { email: "riley@e2e.test", name: "Riley Signed" },
  batchVendor: "Seabreeze Market",
  batchJob: "Seabreeze lot, Saturday",
  waitingJob: "Seabreeze lot, Sunday",
  waitingDeputy: "Casey Waiting",
  /**
   * A Lakeview Community detail with two deputies on it, starting inside the late cancellation window: canceled
   * for the vendor (both are owed late-cancel pay) and reactivated by the coordinator suite.
   */
  backOnJob: "Homecoming lot, back on",
  backOnDeputies: [
    { email: "taylor.backon@e2e.test", name: "Taylor Brooks" },
    { email: "sam.backon@e2e.test", name: "Sam Okafor" },
  ],
} as const;

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** When the payment issue started waiting on the coordinator: 10 days and an hour ago, so it reads "Day 10" at any hour. */
export const issueWaitingSince = (now: Date = new Date()) => new Date(now.getTime() - 10 * DAY - HOUR);

function at(days: number, hour: number, minute = 0): Date {
  const p = agencyDateParts(new Date());
  return agencyInstant(p.year, p.month, p.day + days, hour, minute);
}

export async function seedCoordinator(db: Db): Promise<void> {
  const [rank] = await db.select().from(ranks).where(eq(ranks.name, "Deputy Sheriff"));
  const [type] = await db.select().from(jobTypes).limit(1);
  const pos = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
  const [coordinator] = await db.select().from(users).where(eq(users.email, "coordinator@e2e.test"));
  const [riley] = await db
    .insert(users)
    .values({ ...COORD.signed, emailVerified: true, role: "personnel", rankId: rank.id, mailingAddress: "PO Box 9, Pine Harbor, FL 32401" })
    .returning();

  const [school] = await db.insert(vendors).values({ name: COORD.vendor, billingEmails: ["athletics@school.example"], defaultRateCents: 6500, contactName: "Athletics office" }).returning();
  const [gym] = await db
    .insert(vendorLocations)
    .values({ vendorId: school.id, name: COORD.location, address: COORD.address, lat: 29.4986, lng: -82.1364 })
    .returning();
  const [lantern] = await db
    .insert(vendors)
    .values({ name: COORD.heldVendor, billingEmails: ["ap@lantern.example"], defaultRateCents: 7000, paymentHold: true, paymentHoldReason: "Two invoices unpaid past 30 days" })
    .returning();
  await db.insert(vendorHolds).values({ vendorId: lantern.id, placedBy: coordinator.id, placedAt: new Date(Date.now() - 21 * HOUR), reason: "Two invoices unpaid past 30 days" });

  const job = async (values: Omit<typeof jobs.$inferInsert, "typeId">, count = 1) => {
    const [j] = await db.insert(jobs).values({ state: "scheduled", releaseAt: new Date(Date.now() - 48 * HOUR), typeId: type.id, ...values }).returning();
    const [p] = await db.insert(jobPositions).values({ jobId: j.id, positionTypeId: pos["Deputy Sheriff"], count }).returning();
    return { job: j, positionId: p.id };
  };

  // A vendor request waiting for a coordinator.
  await job({ vendorId: school.id, locationId: gym.id, title: COORD.request, startAt: at(11, 17, 30), endAt: at(11, 21, 30), rateCents: 6500, state: "requested", releaseAt: null });

  // A locked detail that has started: the vendor went on hold before it began.
  const locked = await job({ vendorId: lantern.id, title: COORD.lockedJob, startAt: new Date(Date.now() - HOUR), endAt: new Date(Date.now() + 3 * HOUR), rateCents: 7000 });
  await db.insert(assignments).values({ jobId: locked.job.id, jobPositionId: locked.positionId, userId: riley.id, status: "signed_up", plannedStartAt: locked.job.startAt, plannedEndAt: locked.job.endAt });

  // Two invoices held for review.
  const held = async (title: string, days: number, reason: string) => {
    const j = await job({ vendorId: school.id, locationId: gym.id, title, startAt: at(days, 6), endAt: at(days, 12, 40), rateCents: 7500 });
    const [a] = await db
      .insert(assignments)
      .values({ jobId: j.job.id, jobPositionId: j.positionId, userId: riley.id, status: "billed", billedAt: at(days, 13), plannedStartAt: at(days, 6), plannedEndAt: at(days, 12), actualStartAt: at(days, 6), actualEndAt: at(days, 12, 40), hoursChangeReason: reason })
      .returning();
    await db
      .insert(invoices)
      .values({ assignmentId: a.id, vendorId: school.id, payeeUserId: riley.id, minutes: 405, rateCents: 7500, totalCents: 50625, status: "pending_review", emailStatus: "not_queued", responsibleParty: "coordinator", responsibleSince: at(days, 13) });
  };
  await held(COORD.approveInvoiceJob, -3, "Vendor asked me to stay");
  await held(COORD.sendBackInvoiceJob, -2, "Crowd stayed late");
  {
    const [lakeview] = await db.update(vendors).set({ emailApprovedInvoices: false, billingEmails: ["office@lakeview.example"] }).where(eq(vendors.name, COORD.unsentVendor)).returning();
    const j = await job({ vendorId: lakeview.id, title: COORD.unsentInvoiceJob, startAt: at(-4, 6), endAt: at(-4, 10), rateCents: 7000 });
    const [a] = await db
      .insert(assignments)
      .values({ jobId: j.job.id, jobPositionId: j.positionId, userId: riley.id, status: "billed", billedAt: at(-4, 11), plannedStartAt: at(-4, 6), plannedEndAt: at(-4, 10), actualStartAt: at(-4, 6), actualEndAt: at(-4, 10) })
      .returning();
    await db
      .insert(invoices)
      .values({ assignmentId: a.id, vendorId: lakeview.id, payeeUserId: riley.id, minutes: 240, rateCents: 7000, totalCents: 28000, status: "pending_review", emailStatus: "not_queued", responsibleParty: "coordinator", responsibleSince: at(-4, 11) });
  }

  // A vendor sent weekly: one invoice ready to send (due) and one held until a second deputy bills.
  const [seabreeze] = await db.insert(vendors).values({ name: COORD.batchVendor, billingEmails: ["ap@seabreeze.example"], defaultRateCents: 7000, invoiceSendSchedule: "weekly" }).returning();
  const [casey] = await db.insert(users).values({ name: COORD.waitingDeputy, email: "casey.waiting@e2e.test", emailVerified: true, role: "personnel", rankId: rank.id }).returning();
  const ready = async (title: string, days: number, waiting: boolean) => {
    const j = await job({ vendorId: seabreeze.id, title, startAt: at(days, 8), endAt: at(days, 14), rateCents: 7000 }, waiting ? 2 : 1);
    const [a] = await db
      .insert(assignments)
      .values({ jobId: j.job.id, jobPositionId: j.positionId, userId: riley.id, status: "billed", billedAt: at(days, 15), plannedStartAt: j.job.startAt, plannedEndAt: j.job.endAt, actualStartAt: j.job.startAt, actualEndAt: j.job.endAt })
      .returning();
    if (waiting) await db.insert(assignments).values({ jobId: j.job.id, jobPositionId: j.positionId, userId: casey.id, status: "signed_up", plannedStartAt: j.job.startAt, plannedEndAt: j.job.endAt });
    await db.insert(invoices).values({ assignmentId: a.id, vendorId: seabreeze.id, payeeUserId: riley.id, minutes: 360, rateCents: 7000, totalCents: 42000, status: "ready_to_send", readyAt: at(days, 16), emailStatus: "not_queued" });
  };
  await ready(COORD.batchJob, -12, false);
  await ready(COORD.waitingJob, -11, true);

  // A payment issue on a sent invoice, waiting on the coordinator for 10 days.
  const issueSince = issueWaitingSince();
  const issued = await job({ vendorId: school.id, locationId: gym.id, title: COORD.issueJob, startAt: at(-45, 9), endAt: at(-45, 17), rateCents: 7500 });
  const [ia] = await db
    .insert(assignments)
    .values({ jobId: issued.job.id, jobPositionId: issued.positionId, userId: riley.id, status: "billed", billedAt: at(-45, 18), plannedStartAt: issued.job.startAt, plannedEndAt: issued.job.endAt })
    .returning();
  const [inv] = await db
    .insert(invoices)
    .values({ assignmentId: ia.id, vendorId: school.id, payeeUserId: riley.id, minutes: 480, rateCents: 7500, totalCents: 60000, status: "sent", sentAt: at(-45, 18), emailStatus: "sent", responsibleParty: "coordinator", responsibleSince: issueSince })
    .returning();
  await db.insert(invoiceEvents).values([
    { invoiceId: inv.id, event: "sent", party: "deputy", at: at(-45, 18) },
    { invoiceId: inv.id, actorUserId: riley.id, event: "issue_opened", party: "deputy", note: "Never arrived", at: issueSince },
  ]);
  await db.insert(paymentIssues).values({ invoiceId: inv.id, openedBy: riley.id, note: "Never arrived", createdAt: issueSince, updatedAt: issueSince });

  // An ops plan that is overdue: due yesterday, detail in two days.
  const ops = await job({ vendorId: school.id, locationId: gym.id, title: COORD.opsJob, startAt: at(2, 10), endAt: at(2, 16), rateCents: 7500, opsPlanRequired: true, opsPlanDueAt: at(-1, 10) });
  await db.insert(opsPlans).values({ jobId: ops.job.id, vendorId: school.id, eventName: COORD.opsJob, year: agencyDateParts(ops.job.startAt).year, location: COORD.location });

  // Worked six days ago and never billed: Riley's sign-ups are locked.
  const unbilled = await job({ vendorId: school.id, locationId: gym.id, title: "Old gate shift", startAt: at(-6, 8), endAt: at(-6, 12), rateCents: 6500 });
  await db.insert(assignments).values({ jobId: unbilled.job.id, jobPositionId: unbilled.positionId, userId: riley.id, status: "signed_up", plannedStartAt: unbilled.job.startAt, plannedEndAt: unbilled.job.endAt });

  // Invoices go out by email, so the sender must be set.
  await db.transaction((tx) =>
    updateSettings({ userId: coordinator.id, role: "admin", rankId: null, vendorId: null }, tx, { email: { provider: "smtp", from: "Signal 90 <no-reply@sheriff.example>", smtp: { host: "smtp.test" } }, billingReplyToEmail: "billing@sheriff.example" }),
  );

  // Unfilled and starting within 72 hours.
  await job({ vendorId: school.id, locationId: gym.id, title: COORD.unfilledJob, startAt: new Date(Date.now() + 30 * HOUR), endAt: new Date(Date.now() + 34 * HOUR), rateCents: 6500 }, 2);

  // Two deputies on a released detail for the e2e vendor (Lakeview Community, seeded before the fixtures).
  const [lakeview] = await db.select().from(vendors).where(eq(vendors.name, "Lakeview Community"));
  const backOn = await job({ vendorId: lakeview.id, title: COORD.backOnJob, startAt: new Date(Date.now() + 22 * HOUR), endAt: new Date(Date.now() + 26 * HOUR), rateCents: 6500 }, 2);
  for (const [i, d] of COORD.backOnDeputies.entries()) {
    const [u] = await db.insert(users).values({ ...d, emailVerified: true, role: "personnel", rankId: rank.id }).returning();
    await db.insert(assignments).values({ jobId: backOn.job.id, jobPositionId: backOn.positionId, userId: u.id, status: "signed_up", requestedAt: new Date(Date.now() - (3 - i) * DAY), plannedStartAt: backOn.job.startAt, plannedEndAt: backOn.job.endAt });
  }

  // A deputy note and a flag request to review.
  await db.insert(deputyNotes).values({ vendorId: school.id, body: COORD.note, status: "pending", submittedBy: riley.id, submittedFromJobId: issued.job.id, submittedAt: at(-1, 8) });
  const [motors] = await db.insert(qualifications).values({ name: "Motors" }).onConflictDoNothing().returning();
  const qual = motors ?? (await db.select().from(qualifications).where(eq(qualifications.name, "Motors")))[0];
  await db.insert(qualificationRequests).values({ userId: riley.id, qualificationId: qual.id, note: "Completed the motors course in October." });
}
