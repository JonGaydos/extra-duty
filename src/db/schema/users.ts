import { boolean, date, index, integer, jsonb, pgEnum, pgTable, text, type AnyPgColumn } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";

export const userRole = pgEnum("user_role", ["admin", "coordinator", "personnel", "vendor"]);
export const accessReviewDecision = pgEnum("access_review_decision", ["keep", "change", "deactivate"]);
export const themePreference = pgEnum("theme_preference", ["day", "night"]);
export const mapsApp = pgEnum("maps_app", ["google", "apple", "osm"]);

export const ranks = pgTable("ranks", {
  id: pk(),
  name: text("name").notNull().unique(),
  sortOrder: integer("sort_order").notNull().unique(),
  inLadder: boolean("in_ladder").notNull().default(true),
  active: boolean("active").notNull().default(true),
  ...timestamps,
});

/** Also the Better Auth user table. */
export const users = pgTable(
  "users",
  {
    id: pk(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    emailVerified: boolean("email_verified").notNull().default(false),
    image: text("image"),
    /** Two-factor is required for every account, so it defaults on. */
    twoFactorEnabled: boolean("two_factor_enabled").notNull().default(true),
    phone: text("phone"),
    role: userRole("role").notNull().default("personnel"),
    rankId: text("rank_id").references(() => ranks.id),
    badgeNumber: text("badge_number"),
    active: boolean("active").notNull().default(true),
    /** Set while the account is off after someone leaves (deactivateUser); cleared on reactivation. */
    deactivatedAt: tstz("deactivated_at"),
    deactivatedBy: text("deactivated_by").references((): AnyPgColumn => users.id),
    deactivationReason: text("deactivation_reason"),
    /** The person's last day with the agency (an agency date); sign-ups on details after it were removed. */
    lastDay: date("last_day", { mode: "string" }),
    suspendedUntil: tstz("suspended_until"),
    /** When the last unbilled-details reminder went out; drives the reminder frequency. */
    unbilledReminderSentAt: tstz("unbilled_reminder_sent_at"),
    suspensionReason: text("suspension_reason"),
    mailingAddress: text("mailing_address"),
    lastSignInAt: tstz("last_sign_in_at"),
    lockedAt: tstz("locked_at"),
    lockReason: text("lock_reason"),
    /** Day or night override; null follows the device setting. */
    themePreference: themePreference("theme_preference"),
    /** The maps app "Open in Maps" goes straight to; null asks each time. */
    preferredMapsApp: mapsApp("preferred_maps_app"),
    /** The person's own Calendar and Details filters ("My details only", remembered filters); never shared. */
    detailFilters: jsonb("detail_filters"),
    ...timestamps,
  },
  (t) => [index("users_rank_idx").on(t.rankId)],
);

export const accessReviews = pgTable("access_reviews", {
  id: pk(),
  startedAt: tstz("started_at").notNull().defaultNow(),
  dueAt: tstz("due_at").notNull(),
  completedAt: tstz("completed_at"),
  ...timestamps,
});

export const accessReviewItems = pgTable(
  "access_review_items",
  {
    id: pk(),
    reviewId: text("review_id")
      .notNull()
      .references(() => accessReviews.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    decision: accessReviewDecision("decision"),
    decidedBy: text("decided_by").references(() => users.id),
    decidedAt: tstz("decided_at"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [index("access_review_items_review_idx").on(t.reviewId)],
);
