import { boolean, check, integer, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { jobs } from "./jobs";

export const fileKind = pgEnum("file_kind", ["w9", "contract", "attachment", "ops_plan"]);

export const files = pgTable("files", {
  id: pk(),
  storageKey: text("storage_key").notNull().unique(),
  filename: text("filename").notNull(),
  contentType: text("content_type").notNull(),
  size: integer("size").notNull(),
  encrypted: boolean("encrypted").notNull().default(false),
  ownerUserId: text("owner_user_id").references(() => users.id),
  kind: fileKind("kind").notNull(),
  ...timestamps,
});

export const jobAttachments = pgTable(
  "job_attachments",
  {
    id: pk(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobs.id),
    label: text("label").notNull(),
    fileId: text("file_id").references(() => files.id),
    url: text("url"),
    isContract: boolean("is_contract").notNull().default(false),
    ...timestamps,
  },
  (t) => [
    check(
      "job_attachments_file_xor_url",
      sql`(${t.fileId} is not null and ${t.url} is null) or (${t.fileId} is null and ${t.url} is not null)`,
    ),
  ],
);

export const w9s = pgTable(
  "w9s",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    fileId: text("file_id")
      .notNull()
      .references(() => files.id),
    uploadedAt: tstz("uploaded_at").notNull().defaultNow(),
    current: boolean("current").notNull().default(true),
    ...timestamps,
  },
  (t) => [uniqueIndex("w9s_one_current_per_user").on(t.userId).where(sql`${t.current}`)],
);
