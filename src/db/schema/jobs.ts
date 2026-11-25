import { boolean, doublePrecision, index, integer, jsonb, pgEnum, pgTable, serial, text } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { assignments } from "./assignments";
import { geocodeSource, vendorLocations, vendors } from "./vendors";

export const jobState = pgEnum("job_state", ["requested", "scheduled", "active", "canceled", "declined"]);
export const qualificationRequestStatus = pgEnum("qualification_request_status", [
  "pending",
  "approved",
  "denied",
]);
export const jobChangeStatus = pgEnum("job_change_status", ["pending", "approved", "declined"]);
export const spotOfferMode = pgEnum("spot_offer_mode", ["sequential", "all_backups"]);
export const spotOfferStatus = pgEnum("spot_offer_status", ["open", "accepted", "expired"]);

export const jobTypes = pgTable("job_types", {
  id: pk(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const jobSeries = pgTable("job_series", {
  id: pk(),
  name: text("name"),
  ...timestamps,
});

export const jobs = pgTable(
  "jobs",
  {
    id: pk(),
    number: serial("number").notNull().unique(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    locationId: text("location_id").references(() => vendorLocations.id),
    typeId: text("type_id")
      .notNull()
      .references(() => jobTypes.id),
    seriesId: text("series_id").references(() => jobSeries.id),
    title: text("title").notNull(),
    description: text("description"),
    notes: text("notes"),
    startAt: tstz("start_at").notNull(),
    endAt: tstz("end_at").notNull(),
    rateCents: integer("rate_cents").notNull(),
    /** Set when a coordinator or admin approved this one detail's rate outside the agency range. */
    rateOverrideReason: text("rate_override_reason"),
    rateOverrideBy: text("rate_override_by").references(() => users.id),
    rateOverrideAt: tstz("rate_override_at"),
    minimumBillableMinutes: integer("minimum_billable_minutes"),
    /** Hold this detail's batched invoices until every assigned deputy has billed; null uses the agency setting. */
    waitForAllDeputies: boolean("wait_for_all_deputies"),
    flexEarliestStartAt: tstz("flex_earliest_start_at"),
    flexLatestEndAt: tstz("flex_latest_end_at"),
    flexAllowShorter: boolean("flex_allow_shorter").notNull().default(false),
    opsPlanRequired: boolean("ops_plan_required").notNull().default(false),
    opsPlanDueAt: tstz("ops_plan_due_at"),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    state: jobState("state").notNull().default("scheduled"),
    canceledAt: tstz("canceled_at"),
    canceledByVendor: boolean("canceled_by_vendor").notNull().default(false),
    lateCancelWaivedReason: text("late_cancel_waived_reason"),
    held: boolean("held").notNull().default(false),
    releaseAt: tstz("release_at"),
    requestedByUserId: text("requested_by_user_id").references(() => users.id),
    cancelReason: text("cancel_reason"),
    ...timestamps,
  },
  (t) => [
    index("jobs_vendor_idx").on(t.vendorId),
    index("jobs_start_idx").on(t.startAt),
    index("jobs_state_idx").on(t.state),
  ],
);

export const jobSafety = pgTable("job_safety", {
  id: pk(),
  jobId: text("job_id")
    .notNull()
    .unique()
    .references(() => jobs.id),
  notes: text("notes"),
  addedBy: text("added_by").references(() => users.id),
  addedAt: tstz("added_at").notNull().defaultNow(),
  editedBy: text("edited_by").references(() => users.id),
  editedAt: tstz("edited_at"),
  ...timestamps,
});

export const jobSafetyAddresses = pgTable(
  "job_safety_addresses",
  {
    id: pk(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    address: text("address").notNull(),
    description: text("description"),
    lat: doublePrecision("lat"),
    lng: doublePrecision("lng"),
    /** auto: from the address lookup. manual: placed by hand, and kept until the address changes. */
    geocodeSource: geocodeSource("geocode_source").notNull().default("auto"),
    addedBy: text("added_by").references(() => users.id),
    addedAt: tstz("added_at").notNull().defaultNow(),
    editedBy: text("edited_by").references(() => users.id),
    editedAt: tstz("edited_at"),
    ...timestamps,
  },
  (t) => [index("job_safety_addresses_job_idx").on(t.jobId)],
);

export const qualifications = pgTable("qualifications", {
  id: pk(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

export const positionTypes = pgTable("position_types", {
  id: pk(),
  name: text("name").notNull().unique(),
  eligibleRankIds: text("eligible_rank_ids").array().notNull().default([]),
  requiredQualificationIds: text("required_qualification_ids").array().notNull().default([]),
  isIncidentCommander: boolean("is_incident_commander").notNull().default(false),
  vendorRequestable: boolean("vendor_requestable").notNull().default(false),
  /** Added to a detail's base hourly rate for this position (Incident Commander +$25.00 by default). */
  rateDifferentialCents: integer("rate_differential_cents").notNull().default(0),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const jobPositions = pgTable(
  "job_positions",
  {
    id: pk(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    positionTypeId: text("position_type_id")
      .notNull()
      .references(() => positionTypes.id),
    count: integer("count").notNull().default(1),
    /** The position type's differential when this position was added; its rate is the job's rate plus this. */
    rateDifferentialCents: integer("rate_differential_cents").notNull().default(0),
    eligibleRankIdsOverride: text("eligible_rank_ids_override").array(),
    requiredQualificationIdsOverride: text("required_qualification_ids_override").array(),
    ...timestamps,
  },
  (t) => [index("job_positions_job_idx").on(t.jobId)],
);

export const userQualifications = pgTable(
  "user_qualifications",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    qualificationId: text("qualification_id")
      .notNull()
      .references(() => qualifications.id),
    grantedBy: text("granted_by").references(() => users.id),
    grantedAt: tstz("granted_at").notNull().defaultNow(),
    revokedAt: tstz("revoked_at"),
    ...timestamps,
  },
  (t) => [index("user_qualifications_user_idx").on(t.userId)],
);

export const qualificationRequests = pgTable("qualification_requests", {
  id: pk(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  qualificationId: text("qualification_id")
    .notNull()
    .references(() => qualifications.id),
  note: text("note"),
  status: qualificationRequestStatus("status").notNull().default("pending"),
  decidedBy: text("decided_by").references(() => users.id),
  decidedAt: tstz("decided_at"),
  reason: text("reason"),
  ...timestamps,
});

export const spotOffers = pgTable("spot_offers", {
  id: pk(),
  jobPositionId: text("job_position_id")
    .notNull()
    .references(() => jobPositions.id),
  mode: spotOfferMode("mode").notNull(),
  offeredToAssignmentId: text("offered_to_assignment_id").references(() => assignments.id),
  endsAt: tstz("ends_at").notNull(),
  status: spotOfferStatus("status").notNull().default("open"),
  ...timestamps,
});


/** A vendor's edit to an approved job that needs a coordinator's decision. `patch` holds ISO date strings. */
export const jobChangeRequests = pgTable(
  "job_change_requests",
  {
    id: pk(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    requestedBy: text("requested_by")
      .notNull()
      .references(() => users.id),
    patch: jsonb("patch").notNull(),
    status: jobChangeStatus("status").notNull().default("pending"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: tstz("decided_at"),
    reason: text("reason"),
    ...timestamps,
  },
  (t) => [index("job_change_requests_job_idx").on(t.jobId)],
);
