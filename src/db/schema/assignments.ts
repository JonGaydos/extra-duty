import { boolean, index, integer, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { jobPositions, jobs } from "./jobs";

export const assignmentStatus = pgEnum("assignment_status", [
  "pending_short",
  "signed_up",
  "backup",
  "canceled",
  "removed",
  "no_show",
  "late_canceled",
  "billed",
  "paid",
]);

export const assignments = pgTable(
  "assignments",
  {
    id: pk(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    jobPositionId: text("job_position_id")
      .notNull()
      .references(() => jobPositions.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    status: assignmentStatus("status").notNull(),
    requestedAt: tstz("requested_at").notNull().defaultNow(),
    backupPosition: integer("backup_position"),
    warningVersion: text("warning_version"),
    warningAcceptedAt: tstz("warning_accepted_at"),
    plannedStartAt: tstz("planned_start_at"),
    plannedEndAt: tstz("planned_end_at"),
    actualStartAt: tstz("actual_start_at"),
    actualEndAt: tstz("actual_end_at"),
    hoursChangeReason: text("hours_change_reason"),
    billedAt: tstz("billed_at"),
    overrideReason: text("override_reason"),
    removalReason: text("removal_reason"),
    isIncidentCommander: boolean("is_incident_commander").notNull().default(false),
    /** When a coordinator named this person Incident Commander (null for an IC position, which uses createdAt). */
    icAssignedAt: tstz("ic_assigned_at"),
    /** Set once when the "Bill job #N" alert goes out after the job ends. */
    billReadyAlertedAt: tstz("bill_ready_alerted_at"),
    /** Staff wrote off a worked detail that will never be billed (someone who left); it leaves every to-bill list. */
    writtenOffAt: tstz("written_off_at"),
    writtenOffBy: text("written_off_by").references(() => users.id),
    writeOffReason: text("write_off_reason"),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("assignments_job_user_active_uq")
      .on(t.jobId, t.userId)
      .where(sql`${t.status} not in ('canceled', 'removed')`),
    index("assignments_user_idx").on(t.userId),
    index("assignments_position_idx").on(t.jobPositionId),
  ],
);
