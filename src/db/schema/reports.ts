import { boolean, index, jsonb, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";

/** A saved report definition. Built-ins have no owner and are seeded; `spec` is validated with Zod on save and on run. */
export const savedReports = pgTable(
  "saved_reports",
  {
    id: pk(),
    ownerUserId: text("owner_user_id").references(() => users.id),
    name: text("name").notNull(),
    spec: jsonb("spec").notNull(),
    builtIn: boolean("built_in").notNull().default(false),
    deletedAt: tstz("deleted_at"),
    ...timestamps,
  },
  (t) => [
    index("saved_reports_owner_idx").on(t.ownerUserId),
    uniqueIndex("saved_reports_built_in_name_uq").on(t.name).where(sql`${t.builtIn}`),
  ],
);
