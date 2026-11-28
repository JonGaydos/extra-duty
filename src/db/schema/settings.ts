import { jsonb, pgTable, text } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./common";
import { users } from "./users";

/** Single row holding all settings. */
export const settings = pgTable("settings", {
  id: pk(),
  value: jsonb("value").notNull().default({}),
  ...timestamps,
});

/**
 * An email message the agency edited (owner decision 2026-11-27): one row per message key. A message with no row
 * uses its built-in default, so nothing changes until someone edits one; Reset to default deletes the row.
 */
export const emailMessages = pgTable("email_messages", {
  id: pk(),
  key: text("key").notNull().unique(),
  subject: text("subject").notNull(),
  body: text("body").notNull(),
  updatedBy: text("updated_by").references(() => users.id),
  ...timestamps,
});
