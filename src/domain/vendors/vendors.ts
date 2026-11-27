import { and, asc, eq, isNull, lte, or, gte, isNotNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { users, vendorDocuments, vendorHolds, vendorLocations, vendors, vendorTypes, vendorUsers } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { createInvite } from "../auth/invites";
import { assertCan, type Action } from "../auth/policy";
import { normalizeEmail } from "../auth/sign-in-policy";
import { NotFoundError, ValidationError } from "../errors";
import { readStoredFile, uploadFile, type FileRow } from "../files/files";
import { coordinatorAudience, jobAudience } from "../notifications/audiences";
import { emit } from "../notifications/notify";
import { agencyDayKey } from "../time/agency-time";
import { currentJobsOf } from "../vendor-portal/holds";
import type { Cents } from "../types";
import { geocodeAddress } from "./geocode";
import { outsideRange, rateRangeMessage } from "../jobs/rate";
import type { SendSchedule } from "../invoices/send-schedule";
import { getSettings } from "../settings/settings";
import { cleanChangedContactName, cleanContactName } from "../contact-name";
import { cleanChangedPhone, cleanPhone } from "../phone";
import { isEmail } from "@/lib/is-email";


export type Vendor = typeof vendors.$inferSelect;
export type VendorLocation = typeof vendorLocations.$inferSelect;
export type VendorDocument = typeof vendorDocuments.$inferSelect;

export type VendorInput = {
  name: string;
  typeId: string | null;
  contactName: string | null;
  phone: string | null;
  billingEmails: string[];
  defaultRateCents: Cents | null;
  notes: string | null;
  /** Overrides the agency's invoice send schedule; null uses the agency setting. Optional on create. */
  invoiceSendSchedule?: SendSchedule | null;
  /** "Email approved invoices to this vendor": pre-selects Approve and send (true) or Approve, don't send. */
  emailApprovedInvoices?: boolean;
  /** "Requires a W-9 signed this year": invoices attach the payee's W-9 only when signed in the current calendar year. */
  requiresCurrentYearW9?: boolean;
};

const SCHEDULES: readonly SendSchedule[] = ["immediate", "weekly", "every_2_weeks", "monthly"];

function cleanText(v: string | null | undefined): string | null {
  const t = v?.trim();
  return t ? t : null;
}

function cleanEmails(list: string[]): string[] {
  const out: string[] = [];
  for (const raw of list) {
    const e = normalizeEmail(raw);
    if (!e || !isEmail(e)) throw new ValidationError(`"${String(raw).trim()}" is not a valid email address.`);
    if (!out.includes(e)) out.push(e);
  }
  return out;
}

function cleanRate(v: Cents | null): Cents | null {
  if (v === null) return null;
  // Zero would make every detail unpayable; blank already means the agency default.
  if (!Number.isInteger(v) || v <= 0) throw new ValidationError("The default rate must be more than zero, or blank to use the agency default.");
  return v;
}

/** A vendor's default rate must sit inside the agency range like any detail's rate. */
async function assertDefaultRateInRange(tx: Tx, rate: Cents | null): Promise<void> {
  if (rate === null) return;
  const s = await getSettings(tx);
  if (outsideRange(rate, s)) throw new ValidationError(`${rateRangeMessage(s)}.`);
}

async function assertType(tx: Tx, typeId: string | null): Promise<void> {
  if (!typeId) return;
  const [t] = await tx.select({ id: vendorTypes.id }).from(vendorTypes).where(eq(vendorTypes.id, typeId));
  if (!t) throw new ValidationError("Vendor type not found.");
}

async function getVendorRow(tx: Tx, id: string): Promise<Vendor> {
  const [row] = await tx.select().from(vendors).where(eq(vendors.id, id));
  if (!row) throw new NotFoundError("Vendor not found.");
  return row;
}

/** The vendor row, locked until the transaction ends. */
async function lockVendorRow(tx: Tx, id: string): Promise<Vendor> {
  const [row] = await tx.select().from(vendors).where(eq(vendors.id, id)).for("update");
  if (!row) throw new NotFoundError("Vendor not found.");
  return row;
}

/** A vendor user reaching for another vendor gets NotFound (no hint it exists); everyone else is checked by policy. */
async function authorizeVendor(actor: Actor, tx: Tx, vendorId: string, action: Action): Promise<Vendor> {
  if (actor.role === "vendor" && actor.vendorId !== vendorId) throw new NotFoundError("Vendor not found.");
  assertCan(actor, action, { vendorId });
  return getVendorRow(tx, vendorId);
}

export async function createVendor(actor: Actor, tx: Tx, input: VendorInput): Promise<Vendor> {
  assertCan(actor, "vendor.manage");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Vendor name is required.");
  await assertType(tx, input.typeId);
  await assertDefaultRateInRange(tx, cleanRate(input.defaultRateCents));
  const [row] = await tx
    .insert(vendors)
    .values({
      name,
      typeId: input.typeId,
      contactName: cleanContactName(input.contactName),
      phone: cleanPhone(input.phone),
      billingEmails: cleanEmails(input.billingEmails),
      defaultRateCents: cleanRate(input.defaultRateCents),
      notes: cleanText(input.notes),
    })
    .returning();
  await recordAudit(tx, { actor, action: "vendor.create", entityType: "vendor", entityId: row.id, before: null, after: row });
  return row;
}

function requiredName(raw: string): string {
  const name = raw.trim();
  if (!name) throw new ValidationError("Vendor name is required.");
  return name;
}

/** Adds the invoice send schedule and the approved-invoice email choice to the patch, when given and valid. */
function setInvoiceOptions(patch: Partial<typeof vendors.$inferInsert>, input: Partial<VendorInput>): void {
  if (input.invoiceSendSchedule !== undefined) {
    if (input.invoiceSendSchedule !== null && !SCHEDULES.includes(input.invoiceSendSchedule)) throw new ValidationError("Choose when invoices are sent.");
    patch.invoiceSendSchedule = input.invoiceSendSchedule;
  }
  if (input.emailApprovedInvoices !== undefined) {
    if (typeof input.emailApprovedInvoices !== "boolean") throw new ValidationError("Choose whether approved invoices are emailed to this vendor.");
    patch.emailApprovedInvoices = input.emailApprovedInvoices;
  }
  if (input.requiresCurrentYearW9 !== undefined) {
    if (typeof input.requiresCurrentYearW9 !== "boolean") throw new ValidationError("Choose whether this vendor needs a W-9 signed this year.");
    patch.requiresCurrentYearW9 = input.requiresCurrentYearW9;
  }
}

export async function updateVendor(actor: Actor, tx: Tx, id: string, input: Partial<VendorInput>): Promise<Vendor> {
  assertCan(actor, "vendor.manage");
  const before = await getVendorRow(tx, id);
  const patch: Partial<typeof vendors.$inferInsert> = {};
  if (input.name !== undefined) patch.name = requiredName(input.name);
  if (input.typeId !== undefined) {
    await assertType(tx, input.typeId);
    patch.typeId = input.typeId;
  }
  if (input.contactName !== undefined) patch.contactName = cleanChangedContactName(input.contactName, before.contactName);
  if (input.phone !== undefined) patch.phone = cleanChangedPhone(input.phone, before.phone);
  if (input.billingEmails !== undefined) patch.billingEmails = cleanEmails(input.billingEmails);
  if (input.defaultRateCents !== undefined) {
    patch.defaultRateCents = cleanRate(input.defaultRateCents);
    if (patch.defaultRateCents !== before.defaultRateCents) await assertDefaultRateInRange(tx, patch.defaultRateCents);
  }
  if (input.notes !== undefined) patch.notes = cleanText(input.notes);
  setInvoiceOptions(patch, input);
  if (Object.keys(patch).length === 0) return before;
  const [after] = await tx.update(vendors).set(patch).where(eq(vendors.id, id)).returning();
  await recordAudit(tx, { actor, action: "vendor.update", entityType: "vendor", entityId: id, before, after });
  return after;
}

export async function setVendorActive(actor: Actor, tx: Tx, id: string, active: boolean): Promise<Vendor> {
  assertCan(actor, "vendor.manage");
  const before = await getVendorRow(tx, id);
  if (before.active === active) return before;
  const [after] = await tx.update(vendors).set({ active }).where(eq(vendors.id, id)).returning();
  await recordAudit(tx, {
    actor,
    action: active ? "vendor.activate" : "vendor.deactivate",
    entityType: "vendor",
    entityId: id,
    before,
    after,
  });
  return after;
}

export type VendorFilter = { active?: boolean; typeId?: string };

/** Coordinators and admins see every vendor; a vendor user sees only their own. Personnel are refused. */
export async function listVendors(actor: Actor, tx: Tx, filter: VendorFilter = {}): Promise<Vendor[]> {
  if (actor.role === "vendor") {
    if (!actor.vendorId) return [];
    return tx.select().from(vendors).where(eq(vendors.id, actor.vendorId));
  }
  assertCan(actor, "vendor.read");
  const conds = [];
  if (filter.active !== undefined) conds.push(eq(vendors.active, filter.active));
  if (filter.typeId) conds.push(eq(vendors.typeId, filter.typeId));
  return tx.select().from(vendors).where(and(...conds)).orderBy(asc(vendors.name));
}

// Payment hold

/** One alert per current job of the vendor to the people signed up or in line for it (spec 12.7a, 14). */
async function alertLockChange(tx: Tx, vendor: Vendor, type: "job.locked" | "job.unlocked", title: string, body: string, startAfter: Date = new Date()): Promise<void> {
  // Sequential: alert writes in this transaction.
  for (const job of await currentJobsOf(tx, vendor.id, startAfter, new Date())) {
    await emit(tx, { recipients: await jobAudience(tx, job), type, title: `${title}: #${job.number} ${job.title}`, body, link: `/jobs/${job.id}` });
  }
}

export async function placePaymentHold(actor: Actor, tx: Tx, vendorId: string, reason: string): Promise<Vendor> {
  assertCan(actor, "vendor.paymentHold");
  // Locked, so a second hold placed at the same moment waits here and then sees this one.
  const before = await lockVendorRow(tx, vendorId);
  const why = reason.trim();
  if (!why) throw new ValidationError("A reason is required to place a payment hold.");
  if (before.paymentHold) throw new ValidationError("This vendor already has a payment hold.");
  const [hold] = await tx.insert(vendorHolds).values({ vendorId, placedBy: actor.userId, reason: why }).returning();
  const [after] = await tx
    .update(vendors)
    .set({ paymentHold: true, paymentHoldReason: why })
    .where(eq(vendors.id, vendorId))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "vendor.payment_hold_place",
    entityType: "vendor",
    entityId: vendorId,
    before,
    after: { vendor: after, holdId: hold.id },
    reason: why,
  });
  await alertLockChange(tx, after, "job.locked", "Vendor on hold: do not work this detail", `${why}. You keep your spot, but do not work this detail until a coordinator lifts the hold.`);
  return after;
}

export async function resolvePaymentHold(
  actor: Actor,
  tx: Tx,
  vendorId: string,
  input: { outcome: "fix_coming" | "handled"; note?: string },
): Promise<Vendor> {
  assertCan(actor, "vendor.paymentHold");
  const before = await lockVendorRow(tx, vendorId);
  if (input.outcome !== "fix_coming" && input.outcome !== "handled") throw new ValidationError("Outcome is not valid.");
  if (!before.paymentHold) throw new ValidationError("This vendor has no payment hold.");
  const note = cleanText(input.note);
  // Every open hold ends with the lift (the database allows only one; this also covers rows from before that rule).
  const resolved = await tx
    .update(vendorHolds)
    .set({ resolvedBy: actor.userId, resolvedAt: new Date(), outcome: input.outcome, note })
    .where(and(eq(vendorHolds.vendorId, vendorId), isNull(vendorHolds.resolvedAt)))
    .returning();
  const open = resolved.toSorted((a, b) => a.placedAt.getTime() - b.placedAt.getTime())[0];
  const [after] = await tx
    .update(vendors)
    .set({ paymentHold: false, paymentHoldReason: null })
    .where(eq(vendors.id, vendorId))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "vendor.payment_hold_resolve",
    entityType: "vendor",
    entityId: vendorId,
    before,
    after: { vendor: after, holdId: open?.id ?? null, outcome: input.outcome, note },
  });
  await alertLockChange(tx, after, "job.unlocked", "Vendor hold lifted", "The payment hold is resolved, so you can work this detail.", open?.placedAt);
  return after;
}

// Locations

/**
 * `pin` comes from the address field: a point to store (from its lookup, or placed by hand, which overrides the
 * lookup); null to store no pin without looking it up (no match, or kept as typed); undefined to look it up here.
 */
export type LocationInput = { name: string; address: string | null; notes?: string | null; pin?: { lat: number; lng: number; source: "auto" | "manual" } | null };

/** The pin columns for an address: the field's pin when it sent one, else a lookup that may find nothing. */
async function pinFor(address: string | null, pin: LocationInput["pin"]) {
  if (pin) {
    checkCoords(pin.lat, pin.lng);
    return { lat: pin.lat, lng: pin.lng, geocodeSource: pin.source };
  }
  const found = address && pin === undefined ? await geocodeAddress(address) : null;
  return { lat: found?.lat ?? null, lng: found?.lng ?? null, geocodeSource: "auto" as const };
}

async function getLocationRow(tx: Tx, id: string): Promise<VendorLocation> {
  const [row] = await tx.select().from(vendorLocations).where(eq(vendorLocations.id, id));
  if (!row) throw new NotFoundError("Location not found.");
  return row;
}

async function authorizeLocation(actor: Actor, tx: Tx, locationId: string): Promise<VendorLocation> {
  const loc = await getLocationRow(tx, locationId);
  await authorizeVendor(actor, tx, loc.vendorId, "vendorLocation.manageOwn");
  return loc;
}

function checkCoords(lat: number, lng: number): void {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) {
    throw new ValidationError("The pin position is not valid.");
  }
}

/** Coordinators, admins and the vendor's own users. The address is geocoded; a failed lookup leaves the pin empty. */
export async function addLocation(actor: Actor, tx: Tx, vendorId: string, input: LocationInput): Promise<VendorLocation> {
  await authorizeVendor(actor, tx, vendorId, "vendorLocation.manageOwn");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Location name is required.");
  const address = cleanText(input.address);
  const [row] = await tx
    .insert(vendorLocations)
    .values({ vendorId, name, address, ...(await pinFor(address, input.pin)), notes: cleanText(input.notes) })
    .returning();
  await recordAudit(tx, { actor, action: "vendor_location.create", entityType: "vendor_location", entityId: row.id, before: null, after: row });
  return row;
}

export async function updateLocation(actor: Actor, tx: Tx, locationId: string, input: Partial<LocationInput>): Promise<VendorLocation> {
  const before = await authorizeLocation(actor, tx, locationId);
  const patch: Partial<typeof vendorLocations.$inferInsert> = {};
  if (input.name !== undefined) {
    const name = input.name.trim();
    if (!name) throw new ValidationError("Location name is required.");
    patch.name = name;
  }
  if (input.notes !== undefined) patch.notes = cleanText(input.notes);
  const address = input.address === undefined ? before.address : cleanText(input.address);
  if (address !== before.address) {
    // A new address makes the old pin (automatic or manual) stale.
    Object.assign(patch, { address, ...(await pinFor(address, input.pin)) });
  } else if (input.pin && (input.pin.lat !== before.lat || input.pin.lng !== before.lng || input.pin.source !== before.geocodeSource)) {
    Object.assign(patch, await pinFor(address, input.pin));
  }
  if (Object.keys(patch).length === 0) return before;
  const [after] = await tx.update(vendorLocations).set(patch).where(eq(vendorLocations.id, locationId)).returning();
  await recordAudit(tx, { actor, action: "vendor_location.update", entityType: "vendor_location", entityId: locationId, before, after });
  return after;
}

/** Manual pin correction. */
export async function setLocationPin(
  actor: Actor,
  tx: Tx,
  locationId: string,
  pin: { lat: number; lng: number },
): Promise<VendorLocation> {
  const before = await authorizeLocation(actor, tx, locationId);
  checkCoords(pin.lat, pin.lng);
  const [after] = await tx
    .update(vendorLocations)
    .set({ lat: pin.lat, lng: pin.lng, geocodeSource: "manual" })
    .where(eq(vendorLocations.id, locationId))
    .returning();
  await recordAudit(tx, { actor, action: "vendor_location.set_pin", entityType: "vendor_location", entityId: locationId, before, after });
  return after;
}

/** Locations are never deleted (jobs may reference them): they are deactivated and no longer offered for new details. */
export async function setLocationActive(actor: Actor, tx: Tx, locationId: string, active: boolean): Promise<VendorLocation> {
  const before = await authorizeLocation(actor, tx, locationId);
  if (before.active === active) return before;
  const [after] = await tx.update(vendorLocations).set({ active }).where(eq(vendorLocations.id, locationId)).returning();
  await recordAudit(tx, {
    actor,
    action: active ? "vendor_location.activate" : "vendor_location.deactivate",
    entityType: "vendor_location",
    entityId: locationId,
    before,
    after,
  });
  return after;
}

/** Active locations only unless includeInactive is set (the ones offered for new details). */
export async function listLocations(
  actor: Actor,
  tx: Tx,
  vendorId: string,
  opts: { includeInactive?: boolean } = {},
): Promise<VendorLocation[]> {
  await authorizeVendor(actor, tx, vendorId, "vendor.read");
  const conds = [eq(vendorLocations.vendorId, vendorId)];
  if (!opts.includeInactive) conds.push(eq(vendorLocations.active, true));
  return tx.select().from(vendorLocations).where(and(...conds)).orderBy(asc(vendorLocations.name));
}

// Documents and contracts

export type VendorDocumentInput = {
  kind: "contract" | "other";
  label: string;
  file?: Buffer;
  filename?: string;
  contentType?: string;
  url?: string;
  signedOn?: Date;
  expiresOn?: Date;
};

export function cleanUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    throw new ValidationError("The link is not a valid web address.");
  }
  if (u.protocol !== "https:") throw new ValidationError("The link must start with https://.");
  return u.toString();
}

/** Coordinators and admins. Exactly one of a file or an https link. A vendor with no contract is allowed. */
export async function addVendorDocument(actor: Actor, tx: Tx, vendorId: string, input: VendorDocumentInput): Promise<VendorDocument> {
  assertCan(actor, "vendor.manage");
  await getVendorRow(tx, vendorId);
  if (input.kind !== "contract" && input.kind !== "other") throw new ValidationError("Document kind is not valid.");
  const label = input.label.trim();
  if (!label) throw new ValidationError("A label is required.");
  const hasFile = input.file !== undefined;
  const hasUrl = input.url !== undefined && input.url.trim() !== "";
  if (hasFile === hasUrl) throw new ValidationError("Provide either a file or a link, not both and not neither.");
  const signedOn = input.signedOn ? agencyDayKey(input.signedOn) : null;
  const expiresOn = input.expiresOn ? agencyDayKey(input.expiresOn) : null;
  if (signedOn && expiresOn && expiresOn < signedOn) throw new ValidationError("The expiry date is before the signed date.");

  let fileId: string | null = null;
  let url: string | null = null;
  if (hasFile) {
    if (!input.filename || !input.contentType) throw new ValidationError("A file needs a name and content type.");
    const f = await uploadFile(actor, tx, { kind: "contract", filename: input.filename, contentType: input.contentType, body: input.file! });
    fileId = f.id;
  } else {
    url = cleanUrl(input.url!);
  }
  const [row] = await tx.insert(vendorDocuments).values({ vendorId, kind: input.kind, label, fileId, url, signedOn, expiresOn }).returning();
  await recordAudit(tx, { actor, action: "vendor_document.create", entityType: "vendor_document", entityId: row.id, before: null, after: row });
  return row;
}

/** Coordinators, admins and that vendor's own users. */
export async function listVendorDocuments(actor: Actor, tx: Tx, vendorId: string): Promise<VendorDocument[]> {
  await authorizeVendor(actor, tx, vendorId, "vendor.read");
  return tx.select().from(vendorDocuments).where(eq(vendorDocuments.vendorId, vendorId)).orderBy(asc(vendorDocuments.createdAt));
}

/** An uploaded document's file: that vendor's own users, coordinators and admins. A link document has no file. */
export async function readVendorDocumentFile(actor: Actor, tx: Tx, vendorId: string, documentId: string): Promise<{ row: FileRow; body: Buffer }> {
  await authorizeVendor(actor, tx, vendorId, "vendor.read");
  const [doc] = await tx.select().from(vendorDocuments).where(and(eq(vendorDocuments.id, documentId), eq(vendorDocuments.vendorId, vendorId)));
  if (!doc?.fileId) throw new NotFoundError("Document not found.");
  return readStoredFile(tx, doc.fileId);
}

/** True when the vendor has a contract document in force on the agency date (YYYY-MM-DD): signed by then and not expired. */
export async function vendorHasCurrentContract(tx: Tx, vendorId: string, onDate: string): Promise<boolean> {
  const rows = await tx
    .select({ id: vendorDocuments.id })
    .from(vendorDocuments)
    .where(
      and(
        eq(vendorDocuments.vendorId, vendorId),
        eq(vendorDocuments.kind, "contract"),
        or(isNull(vendorDocuments.signedOn), lte(vendorDocuments.signedOn, onDate)),
        or(isNull(vendorDocuments.expiresOn), gte(vendorDocuments.expiresOn, onDate)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

export type ContractReminder = {
  documentId: string;
  vendorId: string;
  vendorName: string;
  label: string;
  expiresOn: string;
  daysBefore: 60 | 30;
};

function daysUntil(todayKey: string, dateKey: string): number {
  return Math.round((Date.parse(`${dateKey}T00:00:00Z`) - Date.parse(`${todayKey}T00:00:00Z`)) / 86_400_000);
}

/**
 * Finds contracts of active vendors that entered the 60 or 30 day window and
 * records each reminder once (reminded60At and reminded30At, updated in the same transaction as the alert to coordinators and admins).
 * A contract first seen inside 30 days gets only the 30 day reminder.
 */
export async function contractExpiryTick(tx: Tx, now: Date): Promise<ContractReminder[]> {
  const today = agencyDayKey(now);
  const rows = await tx
    .select({ doc: vendorDocuments, vendorName: vendors.name })
    .from(vendorDocuments)
    .innerJoin(vendors, eq(vendors.id, vendorDocuments.vendorId))
    .where(and(eq(vendorDocuments.kind, "contract"), isNotNull(vendorDocuments.expiresOn), eq(vendors.active, true)))
    .orderBy(asc(vendorDocuments.expiresOn), asc(vendorDocuments.id))
    .for("update", { of: vendorDocuments });
  const out: ContractReminder[] = [];
  // Sequential: updates and audits on the locked rows, in this transaction.
  for (const { doc, vendorName } of rows) {
    const days = daysUntil(today, doc.expiresOn!);
    let due: 60 | 30 | null = null;
    if (days >= 0 && days <= 30 && !doc.reminded30At) due = 30;
    else if (days > 30 && days <= 60 && !doc.reminded60At) due = 60;
    if (!due) continue;
    await tx
      .update(vendorDocuments)
      .set(due === 30 ? { reminded30At: now, reminded60At: doc.reminded60At ?? now } : { reminded60At: now })
      .where(eq(vendorDocuments.id, doc.id));
    await recordAudit(tx, {
      actor: "system",
      action: "vendor_document.expiry_reminder",
      entityType: "vendor_document",
      entityId: doc.id,
      after: { daysBefore: due, expiresOn: doc.expiresOn },
    });
    out.push({ documentId: doc.id, vendorId: doc.vendorId, vendorName, label: doc.label, expiresOn: doc.expiresOn!, daysBefore: due });
    await emit(tx, {
      recipients: await coordinatorAudience(tx),
      type: "vendor.contract_expiring",
      title: `${vendorName} contract expires in ${due} days`,
      body: `${doc.label} expires on ${doc.expiresOn}. Renew it before details run out of contract.`,
      link: `/vendors/${doc.vendorId}`,
    });
  }
  return out;
}

// Vendor logins

/** Creates a vendor-role user linked to the vendor and emails an invite. */
export async function createVendorLogin(
  actor: Actor,
  tx: Tx,
  vendorId: string,
  input: { email: string; name: string },
): Promise<typeof users.$inferSelect> {
  assertCan(actor, "vendor.manage");
  const vendor = await getVendorRow(tx, vendorId);
  if (!vendor.active) throw new ValidationError("This vendor is deactivated.");
  const email = normalizeEmail(input.email);
  if (!email || !isEmail(email)) throw new ValidationError("A valid email address is required.");
  const name = input.name.trim();
  if (!name) throw new ValidationError("Name is required.");
  const [dup] = await tx.select({ id: users.id }).from(users).where(eq(users.email, email));
  if (dup) throw new ValidationError("An account with this email already exists.");
  const [user] = await tx.insert(users).values({ email, name, role: "vendor" }).returning();
  await tx.insert(vendorUsers).values({ userId: user.id, vendorId });
  await recordAudit(tx, { actor, action: "user.create", entityType: "user", entityId: user.id, before: null, after: { ...user, vendorId } });
  await createInvite(actor, tx, user.id);
  return user;
}
