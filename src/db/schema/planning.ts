import { boolean, check, date, index, integer, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { vendors } from "./vendors";

export const workScheduleKind = pgEnum("work_schedule_kind", ["weekly", "rotation"]);
export const scheduleExceptionKind = pgEnum("schedule_exception_kind", ["off", "extra"]);

const userRef = () =>
  text("user_id")
    .notNull()
    .references(() => users.id);

/** Private to the owner. One schedule per person; `active` false means no schedule. */
export const workSchedules = pgTable(
  "work_schedules",
  {
    id: pk(),
    userId: userRef(),
    kind: workScheduleKind("kind").notNull(),
    /** Weekly: 0 = Sunday to 6 = Saturday. */
    weekdays: integer("weekdays").array(),
    /** Rotation: one character per day, '1' works. Example `11001110011000`. */
    cycle: text("cycle"),
    /** Day 0 of the rotation (agency date). */
    anchorDate: date("anchor_date", { mode: "string" }).notNull(),
    shiftStart: text("shift_start").notNull(),
    shiftEnd: text("shift_end").notNull(),
    bufferMinutes: integer("buffer_minutes").notNull().default(0),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [
    uniqueIndex("work_schedules_user_idx").on(t.userId),
    check("work_schedules_buffer_check", sql`${t.bufferMinutes} in (0, 15, 30, 45, 60)`),
  ],
);

export const scheduleExceptions = pgTable(
  "schedule_exceptions",
  {
    id: pk(),
    userId: userRef(),
    date: date("date", { mode: "string" }).notNull(),
    kind: scheduleExceptionKind("kind").notNull(),
    shiftStart: text("shift_start"),
    shiftEnd: text("shift_end"),
    ...timestamps,
  },
  (t) => [index("schedule_exceptions_user_idx").on(t.userId, t.date)],
);

export const earningsGoals = pgTable(
  "earnings_goals",
  {
    id: pk(),
    userId: userRef(),
    monthlyCents: integer("monthly_cents"),
    ...timestamps,
  },
  (t) => [uniqueIndex("earnings_goals_user_idx").on(t.userId)],
);

export const hiddenVendors = pgTable(
  "hidden_vendors",
  {
    id: pk(),
    userId: userRef(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("hidden_vendors_user_vendor_idx").on(t.userId, t.vendorId), index("hidden_vendors_vendor_idx").on(t.vendorId)],
);

/**
 * `urlEnc` is the calendar link, encrypted (the link is a secret); null means no link is set, and the row stays so the
 * sync limit survives removing and re-adding a link. `lastFetchedAt` is the last attempt of the current link;
 * `lastSyncRequestedAt` is the last "Sync now" and is never reset.
 */
export const calendarFeeds = pgTable(
  "calendar_feeds",
  {
    id: pk(),
    userId: userRef(),
    urlEnc: text("url_enc"),
    lastFetchedAt: tstz("last_fetched_at"),
    lastSyncRequestedAt: tstz("last_sync_requested_at"),
    lastError: text("last_error"),
    ...timestamps,
  },
  (t) => [uniqueIndex("calendar_feeds_user_idx").on(t.userId)],
);

export const calendarBusy = pgTable(
  "calendar_busy",
  {
    id: pk(),
    feedId: text("feed_id")
      .notNull()
      .references(() => calendarFeeds.id),
    startAt: tstz("start_at").notNull(),
    endAt: tstz("end_at").notNull(),
    title: text("title").notNull(),
    ...timestamps,
  },
  (t) => [index("calendar_busy_feed_idx").on(t.feedId, t.startAt)],
);

/**
 * Personal calendar (.ics) feed tokens. Only the SHA-256 hash is stored; the token is shown once when made.
 * A person has at most one live token (revokedAt null); rotating revokes the old one.
 */
export const calendarTokens = pgTable(
  "calendar_tokens",
  {
    id: pk(),
    userId: userRef(),
    tokenHash: text("token_hash").notNull().unique(),
    revokedAt: tstz("revoked_at"),
    lastUsedAt: tstz("last_used_at"),
    ...timestamps,
  },
  (t) => [index("calendar_tokens_user_idx").on(t.userId)],
);
