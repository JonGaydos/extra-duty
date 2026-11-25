import { index, pgEnum, pgTable, text } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { vendorLocations, vendors } from "./vendors";
import { jobs } from "./jobs";

export const deputyNoteStatus = pgEnum("deputy_note_status", ["pending", "approved", "denied", "retired"]);

/** What a deputy learned about a vendor (or one of its locations), for future deputies. Never shown to vendors. */
export const deputyNotes = pgTable(
  "deputy_notes",
  {
    id: pk(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    /** Set for a note about one location; null for a vendor-wide note. */
    locationId: text("location_id").references(() => vendorLocations.id),
    body: text("body").notNull(),
    status: deputyNoteStatus("status").notNull().default("pending"),
    submittedBy: text("submitted_by")
      .notNull()
      .references(() => users.id),
    submittedFromJobId: text("submitted_from_job_id")
      .notNull()
      .references(() => jobs.id),
    /** The date the author wrote it; shown with the note. */
    submittedAt: tstz("submitted_at").notNull().defaultNow(),
    reviewedBy: text("reviewed_by").references(() => users.id),
    reviewedAt: tstz("reviewed_at"),
    reviewComment: text("review_comment"),
    ...timestamps,
  },
  (t) => [index("deputy_notes_vendor_idx").on(t.vendorId, t.status)],
);
