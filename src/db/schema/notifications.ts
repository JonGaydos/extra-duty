import { boolean, index, integer, jsonb, pgTable, text, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { jobs } from "./jobs";
import { users } from "./users";

export const notifications = pgTable(
  "notifications",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    link: text("link"),
    readAt: tstz("read_at"),
    ...timestamps,
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.readAt)],
);

export const notificationPrefs = pgTable(
  "notification_prefs",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    type: text("type").notNull(),
    email: boolean("email").notNull().default(true),
    push: boolean("push").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("notification_prefs_user_type_uq").on(t.userId, t.type)],
);

/** Daily window (agency local `HH:MM`) during which push is held. */
export const quietHours = pgTable("quiet_hours", {
  id: pk(),
  userId: text("user_id")
    .notNull()
    .unique()
    .references(() => users.id),
  enabled: boolean("enabled").notNull().default(false),
  startTime: text("start_time").notNull().default("22:00"),
  endTime: text("end_time").notNull().default("07:00"),
  ...timestamps,
});

export const pushSubscriptions = pgTable(
  "push_subscriptions",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    endpoint: text("endpoint").notNull().unique(),
    keys: jsonb("keys").notNull(),
    userAgent: text("user_agent"),
    ...timestamps,
  },
  (t) => [index("push_subscriptions_user_idx").on(t.userId)],
);

export const messages = pgTable("messages", {
  id: pk(),
  senderUserId: text("sender_user_id").references(() => users.id),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  sentAt: tstz("sent_at").notNull().defaultNow(),
  recipientCount: integer("recipient_count").notNull().default(0),
  jobId: text("job_id").references(() => jobs.id),
  replyToMessageId: text("reply_to_message_id").references((): AnyPgColumn => messages.id),
  ...timestamps,
});

export const messageRecipients = pgTable(
  "message_recipients",
  {
    id: pk(),
    messageId: text("message_id")
      .notNull()
      .references(() => messages.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    readAt: tstz("read_at"),
    /** Set when the recipient removes the message from their own inbox. */
    hiddenAt: tstz("hidden_at"),
    ...timestamps,
  },
  (t) => [index("message_recipients_user_idx").on(t.userId), index("message_recipients_message_idx").on(t.messageId)],
);
