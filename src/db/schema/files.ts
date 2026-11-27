import { boolean, check, date, index, integer, jsonb, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
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

/** A W-9's review: every new one starts pending; staff approve (with its signature date) or reject (with a reason). */
export const w9Status = pgEnum("w9_status", ["pending", "approved", "rejected"]);

/**
 * `current` is the person's latest upload (history keeps the rest). The W-9 that counts for sign-ups and invoices is
 * the newest approved one. `signedOn` null means the signature date is unknown (grandfathered rows). `uploadedBy` is
 * the staff member who uploaded it for the person, null when they uploaded their own.
 */
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
    status: w9Status("status").notNull().default("pending"),
    uploadedBy: text("uploaded_by").references(() => users.id),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: tstz("reviewed_at"),
    rejectReason: text("reject_reason"),
    signedOn: date("signed_on", { mode: "string" }),
    formRevision: text("form_revision"),
    /** Approved by the release that added W-9 review, so nobody was locked out on update. */
    grandfathered: boolean("grandfathered").notNull().default(false),
    ...timestamps,
  },
  (t) => [uniqueIndex("w9s_one_current_per_user").on(t.userId).where(sql`${t.current}`), index("w9s_user_idx").on(t.userId)],
);

/** Who a W-9 renewal request asks: everyone, named people, a rank or a special flag. */
export type W9RequestAudience =
  | { kind: "everyone" }
  | { kind: "users"; userIds: string[] }
  | { kind: "rank"; rankId: string }
  | { kind: "flag"; qualificationId: string };

/** Staff ask for a new W-9 by a due date (an agency date). After it, anyone asked without a W-9 approved since is sign-up locked. */
export const w9Requests = pgTable("w9_requests", {
  id: pk(),
  requestedBy: text("requested_by")
    .notNull()
    .references(() => users.id),
  requestedAt: tstz("requested_at").notNull().defaultNow(),
  audience: jsonb("audience").$type<W9RequestAudience>().notNull(),
  /** "Everyone", "Deputy Sheriff", a person's name: as asked, kept when names change. */
  audienceLabel: text("audience_label").notNull(),
  dueOn: date("due_on", { mode: "string" }).notNull(),
  note: text("note"),
  ...timestamps,
});

/** The people a request asked, fixed when it was made. `reminderStage`: 0 none sent, 1 the week-before, 2 the day-before. */
export const w9RequestPeople = pgTable(
  "w9_request_people",
  {
    id: pk(),
    requestId: text("request_id")
      .notNull()
      .references(() => w9Requests.id),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    reminderStage: integer("reminder_stage").notNull().default(0),
    ...timestamps,
  },
  (t) => [uniqueIndex("w9_request_people_unique").on(t.requestId, t.userId), index("w9_request_people_user_idx").on(t.userId)],
);
