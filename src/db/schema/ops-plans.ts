import { index, integer, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { vendors } from "./vendors";
import { files } from "./files";
import { jobs } from "./jobs";

export const opsPlanStatus = pgEnum("ops_plan_status", ["due", "submitted", "agreed", "denied"]);

/** One version's review state: awaiting review, or the reviewer's decision. */
export const opsPlanDecision = pgEnum("ops_plan_decision", ["pending", "agreed", "denied"]);

export const opsPlans = pgTable(
  "ops_plans",
  {
    id: pk(),
    jobId: text("job_id").references(() => jobs.id),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    eventName: text("event_name").notNull(),
    year: integer("year").notNull(),
    location: text("location"),
    status: opsPlanStatus("status").notNull().default("due"),
    ...timestamps,
  },
  (t) => [
    index("ops_plans_vendor_idx").on(t.vendorId),
    uniqueIndex("ops_plans_job_uq").on(t.jobId).where(sql`${t.jobId} is not null`),
  ],
);

export const opsPlanVersions = pgTable(
  "ops_plan_versions",
  {
    id: pk(),
    opsPlanId: text("ops_plan_id")
      .notNull()
      .references(() => opsPlans.id),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id),
    submittedBy: text("submitted_by").references(() => users.id),
    submittedAt: tstz("submitted_at").notNull().defaultNow(),
    decision: opsPlanDecision("decision").notNull().default("pending"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: tstz("decided_at"),
    comments: text("comments"),
    ...timestamps,
  },
  (t) => [index("ops_plan_versions_plan_idx").on(t.opsPlanId)],
);

/** One row per reminder sent. The unique (job, kind, key) is the idempotent marker: a second tick cannot claim it. */
export const opsPlanAlerts = pgTable(
  "ops_plan_alerts",
  {
    id: pk(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    kind: text("kind").notNull(),
    key: text("key").notNull(),
    sentAt: tstz("sent_at").notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ops_plan_alerts_uq").on(t.jobId, t.kind, t.key)],
);
