import { and, asc, desc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobs, vendorContacts, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { normalizeEmail } from "../auth/sign-in-policy";
import { cleanChangedContactName, cleanContactName } from "../contact-name";
import { NotFoundError, ValidationError } from "../errors";
import { cleanChangedPhone, cleanPhone } from "../phone";
import { isEmail } from "@/lib/is-email";

export type VendorContact = typeof vendorContacts.$inferSelect;
export type VendorContactInput = { name: string; phone: string; email?: string | null; notes?: string | null };

const text = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

function cleanEmail(v: string | null | undefined): string | null {
  if (!v?.trim()) return null;
  const e = normalizeEmail(v);
  if (!e || !isEmail(e)) throw new ValidationError(`"${v.trim()}" is not a valid email address.`);
  return e;
}

const requiredName = (v: string | null) => {
  if (!v) throw new ValidationError("Enter the contact's name.");
  return v;
};
const requiredPhone = (v: string | null) => {
  if (!v) throw new ValidationError("Enter the contact's phone number.");
  return v;
};

/** A vendor user reaching for another vendor gets NotFound (no hint it exists); everyone else is checked by policy. */
async function authorize(actor: Actor, tx: Tx, vendorId: string, action: "vendorContact.manage" | "vendor.read"): Promise<void> {
  if (actor.role === "vendor" && actor.vendorId !== vendorId) throw new NotFoundError("Vendor not found.");
  assertCan(actor, action, { vendorId });
  const [v] = await tx.select({ id: vendors.id }).from(vendors).where(eq(vendors.id, vendorId));
  if (!v) throw new NotFoundError("Vendor not found.");
}

async function authorizeContact(actor: Actor, tx: Tx, contactId: string): Promise<VendorContact> {
  const [row] = await tx.select().from(vendorContacts).where(eq(vendorContacts.id, contactId));
  if (!row || (actor.role === "vendor" && actor.vendorId !== row.vendorId)) throw new NotFoundError("Contact not found.");
  await authorize(actor, tx, row.vendorId, "vendorContact.manage");
  return row;
}

/** Active contacts by name, unless includeInactive is set (inactive ones last). Coordinators, admins and the vendor's own users. */
export async function listVendorContacts(actor: Actor, tx: Tx, vendorId: string, opts: { includeInactive?: boolean } = {}): Promise<VendorContact[]> {
  await authorize(actor, tx, vendorId, "vendor.read");
  const conds = [eq(vendorContacts.vendorId, vendorId)];
  if (!opts.includeInactive) conds.push(eq(vendorContacts.active, true));
  return tx
    .select()
    .from(vendorContacts)
    .where(and(...conds))
    .orderBy(desc(vendorContacts.active), asc(vendorContacts.name));
}

/** The name must contain a letter and the phone must be 10 US digits; email and notes are optional. */
export async function addVendorContact(actor: Actor, tx: Tx, vendorId: string, input: VendorContactInput): Promise<VendorContact> {
  await authorize(actor, tx, vendorId, "vendorContact.manage");
  const [row] = await tx
    .insert(vendorContacts)
    .values({
      vendorId,
      name: requiredName(cleanContactName(input.name)),
      phone: requiredPhone(cleanPhone(input.phone)),
      email: cleanEmail(input.email),
      notes: text(input.notes),
    })
    .returning();
  await recordAudit(tx, { actor, action: "vendor_contact.create", entityType: "vendor_contact", entityId: row.id, before: null, after: row });
  return row;
}

/** Unchanged names and phones saved before the current rules are kept as they are. */
export async function updateVendorContact(actor: Actor, tx: Tx, contactId: string, input: Partial<VendorContactInput>): Promise<VendorContact> {
  const before = await authorizeContact(actor, tx, contactId);
  const patch: Partial<typeof vendorContacts.$inferInsert> = {};
  if (input.name !== undefined) patch.name = requiredName(cleanChangedContactName(input.name, before.name));
  if (input.phone !== undefined) patch.phone = requiredPhone(cleanChangedPhone(input.phone, before.phone));
  if (input.email !== undefined) patch.email = cleanEmail(input.email);
  if (input.notes !== undefined) patch.notes = text(input.notes);
  if (Object.keys(patch).length === 0) return before;
  const [after] = await tx.update(vendorContacts).set(patch).where(eq(vendorContacts.id, contactId)).returning();
  await recordAudit(tx, { actor, action: "vendor_contact.update", entityType: "vendor_contact", entityId: contactId, before, after });
  return after;
}

/** Contacts are never deleted: a deactivated one is no longer offered on new details. */
export async function setVendorContactActive(actor: Actor, tx: Tx, contactId: string, active: boolean): Promise<VendorContact> {
  const before = await authorizeContact(actor, tx, contactId);
  if (before.active === active) return before;
  const [after] = await tx.update(vendorContacts).set({ active }).where(eq(vendorContacts.id, contactId)).returning();
  await recordAudit(tx, {
    actor,
    action: active ? "vendor_contact.activate" : "vendor_contact.deactivate",
    entityType: "vendor_contact",
    entityId: contactId,
    before,
    after,
  });
  return after;
}

/** "Add a new contact" on a detail's edit form: saved to the detail's own vendor. */
export async function addVendorContactForJob(actor: Actor, tx: Tx, jobId: string, input: VendorContactInput): Promise<VendorContact> {
  const [job] = await tx.select({ vendorId: jobs.vendorId }).from(jobs).where(eq(jobs.id, jobId));
  if (!job || (actor.role === "vendor" && actor.vendorId !== job.vendorId)) throw new NotFoundError("Job not found.");
  return addVendorContact(actor, tx, job.vendorId, input);
}
