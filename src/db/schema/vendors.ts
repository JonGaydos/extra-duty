import { sql } from "drizzle-orm";
import { boolean, date, doublePrecision, index, integer, pgEnum, pgTable, text, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps, tstz } from "./common";
import { users } from "./users";
import { files } from "./files";

export const holdOutcome = pgEnum("vendor_hold_outcome", ["fix_coming", "handled"]);
export const vendorDocumentKind = pgEnum("vendor_document_kind", ["contract", "other"]);
export const geocodeSource = pgEnum("geocode_source", ["auto", "manual"]);
/** When approved invoices go to the vendor: at once, or in a batch on a schedule. */
export const invoiceSendSchedule = pgEnum("invoice_send_schedule", ["immediate", "weekly", "every_2_weeks", "monthly"]);

export const vendorTypes = pgTable("vendor_types", {
  id: pk(),
  name: text("name").notNull().unique(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
});

export const vendors = pgTable("vendors", {
  id: pk(),
  name: text("name").notNull(),
  typeId: text("type_id").references(() => vendorTypes.id),
  contactName: text("contact_name"),
  phone: text("phone"),
  billingEmails: text("billing_emails").array().notNull().default([]),
  defaultRateCents: integer("default_rate_cents"),
  minimumBillableMinutes: integer("minimum_billable_minutes"),
  active: boolean("active").notNull().default(true),
  paymentHold: boolean("payment_hold").notNull().default(false),
  paymentHoldReason: text("payment_hold_reason"),
  /** Overrides the agency's invoice send schedule for this vendor; null uses the agency setting. */
  invoiceSendSchedule: invoiceSendSchedule("invoice_send_schedule"),
  /** Pre-selects "Approve and send" (true) or "Approve, don't send" (false) when a coordinator approves an invoice. */
  emailApprovedInvoices: boolean("email_approved_invoices").notNull().default(true),
  /** Invoices to this vendor attach the payee's W-9 only when it was signed in the current calendar year (agency time). */
  requiresCurrentYearW9: boolean("requires_current_year_w9").notNull().default(false),
  notes: text("notes"),
  ...timestamps,
});

export const vendorHolds = pgTable(
  "vendor_holds",
  {
    id: pk(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    placedBy: text("placed_by").references(() => users.id),
    placedAt: tstz("placed_at").notNull().defaultNow(),
    reason: text("reason"),
    resolvedBy: text("resolved_by").references(() => users.id),
    resolvedAt: tstz("resolved_at"),
    outcome: holdOutcome("outcome"),
    note: text("note"),
    ...timestamps,
  },
  (t) => [
    index("vendor_holds_vendor_idx").on(t.vendorId),
    // One open hold per vendor: a double-submitted hold cannot leave a second one open after the lift.
    uniqueIndex("vendor_holds_one_open_idx").on(t.vendorId).where(sql`${t.resolvedAt} is null`),
  ],
);

export const vendorRestrictions = pgTable(
  "vendor_restrictions",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    reason: text("reason"),
    createdBy: text("created_by").references(() => users.id),
    liftedBy: text("lifted_by").references(() => users.id),
    liftedAt: tstz("lifted_at"),
    ...timestamps,
  },
  (t) => [index("vendor_restrictions_user_vendor_idx").on(t.userId, t.vendorId)],
);

export const vendorDocuments = pgTable("vendor_documents", {
  id: pk(),
  vendorId: text("vendor_id")
    .notNull()
    .references(() => vendors.id),
  kind: vendorDocumentKind("kind").notNull().default("other"),
  label: text("label").notNull(),
  fileId: text("file_id").references(() => files.id),
  url: text("url"),
  signedOn: date("signed_on", { mode: "string" }),
  expiresOn: date("expires_on", { mode: "string" }),
  reminded60At: tstz("reminded_60_at"),
  reminded30At: tstz("reminded_30_at"),
  ...timestamps,
});

export const vendorLocations = pgTable("vendor_locations", {
  id: pk(),
  vendorId: text("vendor_id")
    .notNull()
    .references(() => vendors.id),
  name: text("name").notNull(),
  address: text("address"),
  lat: doublePrecision("lat"),
  lng: doublePrecision("lng"),
  geocodeSource: geocodeSource("geocode_source").notNull().default("auto"),
  active: boolean("active").notNull().default(true),
  notes: text("notes"),
  ...timestamps,
});

export const vendorUsers = pgTable(
  "vendor_users",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    ...timestamps,
  },
  (t) => [uniqueIndex("vendor_users_user_vendor_uq").on(t.userId, t.vendorId)],
);

/** People the deputies ask for on site. Offered on the detail forms; deactivated, never deleted. */
export const vendorContacts = pgTable(
  "vendor_contacts",
  {
    id: pk(),
    vendorId: text("vendor_id")
      .notNull()
      .references(() => vendors.id),
    name: text("name").notNull(),
    phone: text("phone").notNull(),
    email: text("email"),
    notes: text("notes"),
    active: boolean("active").notNull().default(true),
    ...timestamps,
  },
  (t) => [index("vendor_contacts_vendor_idx").on(t.vendorId)],
);
