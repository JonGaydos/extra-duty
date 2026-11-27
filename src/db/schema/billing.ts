import { boolean, index, integer, pgEnum, pgTable, serial, text } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { vendors } from "./vendors";
import { assignments } from "./assignments";

export const invoiceStatus = pgEnum("invoice_status", ["pending_review", "ready_to_send", "sent", "returned", "paid", "written_off", "approved_unsent"]);
export const emailStatus = pgEnum("invoice_email_status", ["queued", "sent", "failed", "not_queued"]);
export const invoiceKind = pgEnum("invoice_kind", ["detail", "late_cancel"]);
export const responsibleParty = pgEnum("responsible_party", ["deputy", "coordinator", "vendor"]);
export const notePresetContext = pgEnum("note_preset_context", [
  "vendor_paid",
  "deputy_paid",
  "report_nonpayment",
  "issue_note",
  "waiting_on",
  "send_back",
]);
export const paymentIssueStatus = pgEnum("payment_issue_status", ["open", "paid", "resolved", "written_off"]);
/** Who may read a note: `internal` staff only, `deputy` staff and the payee, `vendor` also goes to the vendor. */
export const issueNoteVisibility = pgEnum("payment_issue_note_visibility", ["internal", "deputy", "vendor"]);
export const waitingOn = pgEnum("payment_issue_waiting_on", ["coordinator", "vendor", "deputy"]);

export const paymentMethods = pgTable("payment_methods", {
  id: pk(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

/** One batched send: every invoice in it went to the vendor in one email with a cover summary. */
export const invoiceBatches = pgTable(
  "invoice_batches",
  {
    id: pk(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    sentBy: text("sent_by")
      .notNull()
      .references(() => users.id),
    sentAt: tstz("sent_at").notNull(),
    /** Why it went before its scheduled date or before every deputy billed; null when on time and complete. */
    earlyReason: text("early_reason"),
    attachW9ForAll: boolean("attach_w9_for_all").notNull().default(false),
    emailStatus: emailStatus("email_status").notNull().default("queued"),
    ...timestamps,
  },
  (t) => [index("invoice_batches_vendor_idx").on(t.vendorId)],
);

export const invoices = pgTable(
  "invoices",
  {
    id: pk(),
    number: serial("number").notNull().unique(),
    assignmentId: text("assignment_id")
      .notNull()
      .unique()
      .references(() => assignments.id),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    payeeUserId: text("payee_user_id")
      .notNull()
      .references(() => users.id),
    minutes: integer("minutes").notNull(),
    rateCents: integer("rate_cents").notNull(),
    totalCents: integer("total_cents").notNull(),
    status: invoiceStatus("status").notNull().default("pending_review"),
    revision: integer("revision").notNull().default(0),
    /** Minimum for this invoice only; wins over the job, vendor and agency minimums. */
    minimumOverrideMinutes: integer("minimum_override_minutes"),
    sentAt: tstz("sent_at"),
    /** When the invoice was approved into the batch queue (status ready_to_send). */
    readyAt: tstz("ready_at"),
    batchId: text("batch_id").references(() => invoiceBatches.id),
    /** A paid invoice whose paid version waits for (or rides in) the vendor's next batch; cleared once that batch is emailed. */
    paidSendQueued: boolean("paid_send_queued").notNull().default(false),
    attachW9: boolean("attach_w9").notNull().default(false),
    /** The coordinator who turned attachW9 on; the W-9 read is audited as theirs. Null when the payee chose it. */
    w9RequestedBy: text("w9_requested_by").references(() => users.id),
    emailStatus: emailStatus("email_status").notNull().default("queued"),
    kind: invoiceKind("kind").notNull().default("detail"),
    deputyPaidAt: tstz("deputy_paid_at"),
    deputyMethodId: text("deputy_method_id").references(() => paymentMethods.id),
    deputyReference: text("deputy_reference"),
    vendorPaidAt: tstz("vendor_paid_at"),
    vendorPaidMethodId: text("vendor_paid_method_id").references(() => paymentMethods.id),
    vendorPaidReference: text("vendor_paid_reference"),
    responsibleParty: responsibleParty("responsible_party"),
    responsibleSince: tstz("responsible_since"),
    closedReason: text("closed_reason"),
    /**
     * Closed as paid by the payee's own payment confirmation while it was with the vendor. With no vendorPaidAt it is
     * "Vendor not confirmed": paid, and the vendor may still add their own mark for their records.
     */
    closedByDeputy: boolean("closed_by_deputy").notNull().default(false),
    ...timestamps,
  },
  (t) => [index("invoices_vendor_idx").on(t.vendorId), index("invoices_status_idx").on(t.status), index("invoices_payee_idx").on(t.payeeUserId)],
);

export const invoiceEvents = pgTable(
  "invoice_events",
  {
    id: pk(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    actorUserId: text("actor_user_id").references(() => users.id),
    event: text("event").notNull(),
    party: text("party"),
    note: text("note"),
    /** Fails closed: vendors see an event only when a writer sets this true (and its name is allowlisted in invoiceTimeline). */
    vendorVisible: boolean("vendor_visible").notNull().default(false),
    at: tstz("at").notNull().defaultNow(),
    ...timestamps,
  },
  (t) => [index("invoice_events_invoice_idx").on(t.invoiceId)],
);

export const notePresets = pgTable("note_presets", {
  id: pk(),
  context: notePresetContext("context").notNull(),
  text: text("text").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const paymentIssues = pgTable(
  "payment_issues",
  {
    id: pk(),
    invoiceId: text("invoice_id")
      .notNull()
      .references(() => invoices.id),
    openedBy: text("opened_by").references(() => users.id),
    note: text("note"),
    status: paymentIssueStatus("status").notNull().default("open"),
    waitingOn: waitingOn("waiting_on"),
    closedAt: tstz("closed_at"),
    ...timestamps,
  },
  (t) => [index("payment_issues_invoice_idx").on(t.invoiceId)],
);

export const paymentIssueNotes = pgTable("payment_issue_notes", {
  id: pk(),
  issueId: text("issue_id")
    .notNull()
    .references(() => paymentIssues.id),
  authorUserId: text("author_user_id").references(() => users.id),
  note: text("note").notNull(),
  visibility: issueNoteVisibility("visibility").notNull().default("deputy"),
  ...timestamps,
});

/** A coordinator lifts a person's billing lock until `until`. The newest unexpired row applies. */
export const billingLockOverrides = pgTable(
  "billing_lock_overrides",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    reason: text("reason").notNull(),
    until: tstz("until").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    ...timestamps,
  },
  (t) => [index("billing_lock_overrides_user_idx").on(t.userId)],
);
