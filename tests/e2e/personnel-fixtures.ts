/**
 * Data for the personnel screens suite, written straight to the e2e database before the app starts (no
 * service call here needs the app). Times are relative to now and set in agency time.
 */
import { eq } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  assignments,
  auditLog,
  invoiceEvents,
  invoices,
  jobPositions,
  jobs,
  jobSafety,
  jobSafetyAddresses,
  jobTypes,
  messageRecipients,
  messages,
  notifications,
  positionTypes,
  ranks,
  users,
  vendorLocations,
  vendors,
} from "@/db/schema";
import { updateSettings } from "@/domain/settings/settings";
import { agencyDateParts, agencyInstant } from "@/domain/time/agency-time";

export const WARNING_TEXT = "Extra duty is voluntary. Work the detail as scheduled, or cancel early so someone else can take it.";

export const FIXTURE = {
  openJob: "Town center patrol",
  cappedJob: "Night lot watch",
  cappedHeld: "Morning gate shift",
  flexJob: "Right-of-way clearing",
  pastJob: "RV lot security",
  invoicedJob: "Arts festival gate",
  requestedJob: "Unapproved festival request",
  alert: "Spot opened: Town center patrol",
  capped: { email: "capped@e2e.test", name: "Casey Capped" },
  /** A deputy whose sign-up a suspension removed (the suspension itself has since been lifted). */
  suspensionRemoved: { email: "jordan.removed@e2e.test", name: "Jordan Removed" },
  suspensionRemovedJob: "Harbor dock watch",
} as const;

const HOUR = 3_600_000;

/** Agency wall-clock time `days` from today. */
function at(days: number, hour: number, minute = 0): Date {
  const p = agencyDateParts(new Date());
  return agencyInstant(p.year, p.month, p.day + days, hour, minute);
}

export async function seedPersonnel(db: Db): Promise<void> {
  const [rank] = await db.select().from(ranks).where(eq(ranks.name, "Deputy Sheriff"));
  const [type] = await db.select().from(jobTypes).limit(1);
  const pos = Object.fromEntries((await db.select().from(positionTypes)).map((p) => [p.name, p.id]));
  const [deputy] = await db.select().from(users).where(eq(users.email, "deputy@e2e.test"));
  const [coordinator] = await db.select().from(users).where(eq(users.email, "coordinator@e2e.test"));
  await db.update(users).set({ mailingAddress: "PO Box 12, Gulf Haven, FL 32400", phone: "850-555-0142" }).where(eq(users.id, deputy.id));
  const [capped] = await db.insert(users).values({ ...FIXTURE.capped, emailVerified: true, role: "personnel", rankId: rank.id }).returning();

  // The signup warning shown in the acceptance dialog.
  await db.transaction((tx) =>
    updateSettings({ userId: coordinator.id, role: "coordinator", rankId: null, vendorId: null }, tx, { signupWarningText: WARNING_TEXT }),
  );

  const [harborfront] = await db.insert(vendors).values({ name: "Harborfront Arts", billingEmails: ["billing@harborfront.example"], defaultRateCents: 7000 }).returning();
  const [coastal] = await db.insert(vendors).values({ name: "Coastal Line Clearing", billingEmails: ["ap@coastal.example"], defaultRateCents: 7000 }).returning();
  const [rv] = await db.insert(vendors).values({ name: "Gulfway RV", billingEmails: ["billing@rv.example"], defaultRateCents: 7500 }).returning();
  const [plaza] = await db
    .insert(vendorLocations)
    .values({ vendorId: harborfront.id, name: "Town center", address: "25 Town Square, Gulf Haven, FL 32400", lat: 29.3274, lng: -82.1627 })
    .returning();
  const [yard] = await db
    .insert(vendorLocations)
    .values({ vendorId: coastal.id, name: "Pine Harbor yard", address: "350 Industrial Dr, Pine Harbor, FL 32401", lat: 29.4988, lng: -82.1361 })
    .returning();

  const released = { state: "scheduled" as const, releaseAt: new Date(Date.now() - 48 * HOUR), typeId: type.id };
  const job = async (values: Omit<typeof jobs.$inferInsert, "typeId">, positions: Array<[string, number]>) => {
    const [j] = await db.insert(jobs).values({ ...released, ...values }).returning();
    const ps = [];
    for (const [name, count] of positions) ps.push((await db.insert(jobPositions).values({ jobId: j.id, positionTypeId: pos[name], count }).returning())[0]);
    return { job: j, positions: ps };
  };

  await job(
    { vendorId: harborfront.id, locationId: plaza.id, title: FIXTURE.openJob, description: "Foot patrol around the square during the evening market.", startAt: at(3, 14), endAt: at(3, 18), rateCents: 7000 },
    [["Deputy Sheriff", 1]],
  );

  const flex = await job(
    {
      vendorId: coastal.id,
      locationId: yard.id,
      title: FIXTURE.flexJob,
      description: "Traffic control for a tree-trimming crew clearing power lines. Check in with the crew lead at the yard.",
      startAt: at(6, 7),
      endAt: at(6, 15),
      flexEarliestStartAt: at(6, 6, 30),
      flexLatestEndAt: at(6, 16),
      flexAllowShorter: true,
      rateCents: 7000,
      contactName: "Rowan Fairley",
      contactPhone: "850-555-0199",
    },
    [["Deputy Sheriff", 2], ["CSO", 1]],
  );
  await db.insert(jobSafety).values({ jobId: flex.job.id, notes: "Crew reported a resident threatening workers near this address last month. Stay with the crew.", addedBy: coordinator.id });
  await db.insert(jobSafetyAddresses).values({ jobId: flex.job.id, address: "123 Main St, Pine Harbor, FL 32401", description: "Verbal threats toward crew", lat: 29.4991, lng: -82.1352, addedBy: coordinator.id });

  // The capped deputy holds a 12-hour shift; the night job six hours later would make 18 of 16 hours in 24.
  const held = await job({ vendorId: harborfront.id, locationId: plaza.id, title: FIXTURE.cappedHeld, startAt: at(9, 6), endAt: at(9, 18), rateCents: 7000 }, [["Deputy Sheriff", 1]]);
  await db.insert(assignments).values({ jobId: held.job.id, jobPositionId: held.positions[0].id, userId: capped.id, status: "signed_up", warningVersion: "1", warningAcceptedAt: new Date(), plannedStartAt: held.job.startAt, plannedEndAt: held.job.endAt });
  await job({ vendorId: harborfront.id, locationId: plaza.id, title: FIXTURE.cappedJob, startAt: at(9, 20), endAt: at(10, 2), rateCents: 7000 }, [["Deputy Sheriff", 1]]);

  // A sign-up removed by a suspension, written the way suspendUser writes it.
  const [jordan] = await db.insert(users).values({ ...FIXTURE.suspensionRemoved, emailVerified: true, role: "personnel", rankId: rank.id }).returning();
  const dock = await job({ vendorId: harborfront.id, locationId: plaza.id, title: FIXTURE.suspensionRemovedJob, startAt: at(4, 10), endAt: at(4, 14), rateCents: 7000 }, [["Deputy Sheriff", 1]]);
  const [removed] = await db
    .insert(assignments)
    .values({ jobId: dock.job.id, jobPositionId: dock.positions[0].id, userId: jordan.id, status: "removed", removalReason: "Suspended", warningVersion: "1", warningAcceptedAt: new Date() })
    .returning();
  await db.insert(auditLog).values({ actorUserId: coordinator.id, action: "assignment.suspension_remove", entityType: "assignment", entityId: removed.id, after: removed, reason: "Suspended: Policy review" });

  // Worked and ended two hours ago: ready to bill.
  const end = new Date(Math.floor((Date.now() - 2 * HOUR) / (15 * 60_000)) * 15 * 60_000);
  const past = await job({ vendorId: rv.id, title: FIXTURE.pastJob, startAt: new Date(end.getTime() - 6 * HOUR), endAt: end, rateCents: 7500 }, [["Deputy Sheriff", 1]]);
  await db.insert(assignments).values({ jobId: past.job.id, jobPositionId: past.positions[0].id, userId: deputy.id, status: "signed_up", warningVersion: "1", warningAcceptedAt: new Date(), plannedStartAt: past.job.startAt, plannedEndAt: past.job.endAt });

  // Billed ten days ago and waiting on the vendor.
  const old = await job({ vendorId: harborfront.id, locationId: plaza.id, title: FIXTURE.invoicedJob, startAt: at(-10, 9), endAt: at(-10, 15), rateCents: 7500 }, [["Deputy Sheriff", 1]]);
  const [a] = await db
    .insert(assignments)
    .values({ jobId: old.job.id, jobPositionId: old.positions[0].id, userId: deputy.id, status: "billed", billedAt: at(-10, 16), plannedStartAt: old.job.startAt, plannedEndAt: old.job.endAt })
    .returning();
  const [inv] = await db
    .insert(invoices)
    .values({ assignmentId: a.id, vendorId: harborfront.id, payeeUserId: deputy.id, minutes: 360, rateCents: 7500, totalCents: 45000, status: "sent", sentAt: at(-10, 16), emailStatus: "sent", responsibleParty: "vendor", responsibleSince: at(-10, 16) })
    .returning();
  await db.insert(invoiceEvents).values({ invoiceId: inv.id, event: "sent", party: "deputy", at: at(-10, 16) });

  // A vendor request no coordinator has approved: personnel must never see it.
  await job({ vendorId: harborfront.id, locationId: plaza.id, title: FIXTURE.requestedJob, startAt: at(12, 9), endAt: at(12, 13), rateCents: 7000, state: "requested", releaseAt: null }, [["Deputy Sheriff", 1]]);

  await db.insert(notifications).values({ userId: deputy.id, type: "spot.opened_first_come", title: FIXTURE.alert, body: "A Deputy Sheriff spot is open.", link: "/jobs" });

  const [m] = await db
    .insert(messages)
    .values({ senderUserId: coordinator.id, subject: "Holiday rate is $90", body: "All Dec 24 and 25 details have been raised to $90 an hour.", recipientCount: 2, sentAt: at(-1, 9, 40) })
    .returning();
  await db.insert(messageRecipients).values([{ messageId: m.id, userId: deputy.id }, { messageId: m.id, userId: capped.id }]);
}
