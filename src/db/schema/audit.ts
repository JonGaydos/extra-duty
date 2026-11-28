import { index, integer, jsonb, pgTable, serial, text } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";

export const auditLog = pgTable(
  "audit_log",
  {
    id: pk(),
    actorUserId: text("actor_user_id").references(() => users.id),
    action: text("action").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id"),
    before: jsonb("before"),
    after: jsonb("after"),
    reason: text("reason"),
    at: tstz("at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("audit_log_entity_idx").on(t.entityType, t.entityId), index("audit_log_at_idx").on(t.at)],
);

/**
 * A printed Audit Record (owner decision 2026-11-27): which entries it holds, in order, and the SHA-256 integrity code
 * printed on it, so an admin can later check a printed copy against the audit log. Never edited.
 */
export const auditRecords = pgTable("audit_records", {
  id: pk(),
  /** Shown as "AR-000012". */
  number: serial("number").notNull().unique(),
  createdBy: text("created_by")
    .notNull()
    .references(() => users.id),
  /** The filters in plain words, as printed on the cover. */
  filters: text("filters").array().notNull(),
  /** The query as given, for reference. */
  query: jsonb("query").notNull(),
  entryIds: text("entry_ids").array().notNull(),
  entryCount: integer("entry_count").notNull(),
  integrity: text("integrity").notNull(),
  ...timestamps,
});
