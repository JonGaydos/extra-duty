import { asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobTypes, notePresets, paymentMethods, positionTypes, qualifications, ranks, vendorTypes } from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { assertCan } from "../auth/policy";
import { NotFoundError, ValidationError } from "../errors";

export type JobType = typeof jobTypes.$inferSelect;
export type VendorType = typeof vendorTypes.$inferSelect;
export type PaymentMethod = typeof paymentMethods.$inferSelect;
export type PositionType = typeof positionTypes.$inferSelect;
export type NotePreset = typeof notePresets.$inferSelect;
export type NotePresetContext = NotePreset["context"];

export const NOTE_PRESET_CONTEXTS: readonly NotePresetContext[] = [
  "vendor_paid",
  "deputy_paid",
  "report_nonpayment",
  "issue_note",
  "waiting_on",
  "send_back",
];

/**
 * Job types, vendor types and payment methods share one shape: a unique name, active flag and order.
 * The three tables have identical columns, so they are typed through `jobTypes`.
 */
type NamedTable = typeof jobTypes;
type Named = JobType;

function namedCatalog(table: NamedTable, entity: string, label: string) {
  async function get(tx: Tx, id: string): Promise<Named> {
    const [row] = await tx.select().from(table).where(eq(table.id, id));
    if (!row) throw new NotFoundError(`${label} not found.`);
    return row;
  }
  async function assertNameFree(tx: Tx, name: string, exceptId?: string) {
    const rows = await tx.select({ id: table.id }).from(table).where(eq(table.name, name));
    if (rows.some((r) => r.id !== exceptId)) {
      throw new ValidationError(`A ${label.toLowerCase()} named "${name}" already exists.`);
    }
  }
  return {
    list: (actor: Actor, tx: Tx): Promise<Named[]> => {
      assertCan(actor, "settings.update.rules");
      return tx.select().from(table).orderBy(asc(table.sortOrder), asc(table.name));
    },
    create: async (actor: Actor, tx: Tx, input: { name: string; sortOrder?: number }): Promise<Named> => {
      assertCan(actor, "settings.update.rules");
      const name = input.name.trim();
      if (!name) throw new ValidationError(`${label} name is required.`);
      await assertNameFree(tx, name);
      const [row] = await tx
        .insert(table)
        .values({ name, sortOrder: input.sortOrder ?? 0 })
        .returning();
      await recordAudit(tx, { actor, action: `${entity}.create`, entityType: entity, entityId: row.id, before: null, after: row });
      return row;
    },
    update: async (actor: Actor, tx: Tx, id: string, input: { name?: string; sortOrder?: number }): Promise<Named> => {
      assertCan(actor, "settings.update.rules");
      const before = await get(tx, id);
      const patch: { name?: string; sortOrder?: number } = {};
      if (input.name !== undefined) {
        const name = input.name.trim();
        if (!name) throw new ValidationError(`${label} name is required.`);
        await assertNameFree(tx, name, id);
        patch.name = name;
      }
      if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
      if (!Object.keys(patch).length) return before;
      const [after] = await tx.update(table).set(patch).where(eq(table.id, id)).returning();
      await recordAudit(tx, { actor, action: `${entity}.update`, entityType: entity, entityId: id, before, after });
      return after;
    },
    /** Rows are referenced by jobs, vendors and invoices, so they are turned off, never deleted. */
    setActive: async (actor: Actor, tx: Tx, id: string, active: boolean): Promise<Named> => {
      assertCan(actor, "settings.update.rules");
      const before = await get(tx, id);
      if (before.active === active) return before;
      const [after] = await tx.update(table).set({ active }).where(eq(table.id, id)).returning();
      await recordAudit(tx, {
        actor,
        action: `${entity}.${active ? "activate" : "deactivate"}`,
        entityType: entity,
        entityId: id,
        before,
        after,
      });
      return after;
    },
  };
}

const jobTypeOps = namedCatalog(jobTypes, "job_type", "Job type");
export const listJobTypes = jobTypeOps.list;
export const createJobType = jobTypeOps.create;
export const updateJobType = jobTypeOps.update;
export const setJobTypeActive = jobTypeOps.setActive;

const vendorTypeOps = namedCatalog(vendorTypes as unknown as NamedTable, "vendor_type", "Vendor type");
export const listVendorTypes = vendorTypeOps.list;
export const createVendorType = vendorTypeOps.create;
export const updateVendorType = vendorTypeOps.update;
export const setVendorTypeActive = vendorTypeOps.setActive;

const paymentMethodOps = namedCatalog(paymentMethods as unknown as NamedTable, "payment_method", "Payment method");
export const listPaymentMethods = paymentMethodOps.list;
export const createPaymentMethod = paymentMethodOps.create;
export const updatePaymentMethod = paymentMethodOps.update;
export const setPaymentMethodActive = paymentMethodOps.setActive;

// Position types

export type PositionTypeInput = {
  name: string;
  eligibleRankIds: string[];
  requiredQualificationIds: string[];
  isIncidentCommander: boolean;
  vendorRequestable: boolean;
  /** Cents an hour added to a detail's base rate for this position; left out keeps the current value. */
  rateDifferentialCents?: number;
  sortOrder?: number;
};

/** The most a position may add to a detail's rate: $500.00 an hour. */
export const MAX_RATE_DIFFERENTIAL_CENTS = 50_000;

function differential(cents: number): number {
  if (!Number.isInteger(cents) || cents < 0 || cents > MAX_RATE_DIFFERENTIAL_CENTS) {
    throw new ValidationError("The pay differential must be between $0.00 and $500.00 an hour, in whole cents.");
  }
  return cents;
}

async function normalizePositionType(tx: Tx, input: PositionTypeInput) {
  const name = input.name.trim();
  if (!name) throw new ValidationError("Position type name is required.");
  const eligibleRankIds = [...new Set(input.eligibleRankIds)];
  const requiredQualificationIds = [...new Set(input.requiredQualificationIds)];
  if (!eligibleRankIds.length) throw new ValidationError("Choose at least one eligible rank.");
  const foundRanks = await tx.select({ id: ranks.id }).from(ranks).where(inArray(ranks.id, eligibleRankIds));
  if (foundRanks.length !== eligibleRankIds.length) throw new ValidationError("Rank not found.");
  if (requiredQualificationIds.length) {
    const found = await tx
      .select({ id: qualifications.id })
      .from(qualifications)
      .where(inArray(qualifications.id, requiredQualificationIds));
    if (found.length !== requiredQualificationIds.length) throw new ValidationError("Qualification not found.");
  }
  return {
    name,
    eligibleRankIds,
    requiredQualificationIds,
    isIncidentCommander: input.isIncidentCommander,
    vendorRequestable: input.vendorRequestable,
    ...(input.rateDifferentialCents === undefined ? {} : { rateDifferentialCents: differential(input.rateDifferentialCents) }),
    ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
  };
}

async function getPositionType(tx: Tx, id: string): Promise<PositionType> {
  const [row] = await tx.select().from(positionTypes).where(eq(positionTypes.id, id));
  if (!row) throw new NotFoundError("Position type not found.");
  return row;
}

async function assertPositionNameFree(tx: Tx, name: string, exceptId?: string) {
  const rows = await tx.select({ id: positionTypes.id }).from(positionTypes).where(eq(positionTypes.name, name));
  if (rows.some((r) => r.id !== exceptId)) throw new ValidationError(`A position type named "${name}" already exists.`);
}

export function listPositionTypes(actor: Actor, tx: Tx): Promise<PositionType[]> {
  assertCan(actor, "settings.update.rules");
  return tx.select().from(positionTypes).orderBy(asc(positionTypes.sortOrder), asc(positionTypes.name));
}

export async function createPositionType(actor: Actor, tx: Tx, input: PositionTypeInput): Promise<PositionType> {
  assertCan(actor, "settings.update.rules");
  const v = await normalizePositionType(tx, input);
  await assertPositionNameFree(tx, v.name);
  const [row] = await tx.insert(positionTypes).values(v).returning();
  await recordAudit(tx, { actor, action: "position_type.create", entityType: "position_type", entityId: row.id, before: null, after: row });
  return row;
}

export async function updatePositionType(
  actor: Actor,
  tx: Tx,
  id: string,
  input: PositionTypeInput,
): Promise<PositionType> {
  assertCan(actor, "settings.update.rules");
  const before = await getPositionType(tx, id);
  const v = await normalizePositionType(tx, input);
  await assertPositionNameFree(tx, v.name, id);
  const [after] = await tx.update(positionTypes).set(v).where(eq(positionTypes.id, id)).returning();
  await recordAudit(tx, { actor, action: "position_type.update", entityType: "position_type", entityId: id, before, after });
  return after;
}

/** Job positions reference position types, so they are turned off, never deleted. */
export async function setPositionTypeActive(actor: Actor, tx: Tx, id: string, active: boolean): Promise<PositionType> {
  assertCan(actor, "settings.update.rules");
  const before = await getPositionType(tx, id);
  if (before.active === active) return before;
  const [after] = await tx.update(positionTypes).set({ active }).where(eq(positionTypes.id, id)).returning();
  await recordAudit(tx, {
    actor,
    action: `position_type.${active ? "activate" : "deactivate"}`,
    entityType: "position_type",
    entityId: id,
    before,
    after,
  });
  return after;
}

// Note presets

async function getPreset(tx: Tx, id: string): Promise<NotePreset> {
  const [row] = await tx.select().from(notePresets).where(eq(notePresets.id, id));
  if (!row) throw new NotFoundError("Note preset not found.");
  return row;
}

export function listNotePresets(actor: Actor, tx: Tx, context?: NotePresetContext): Promise<NotePreset[]> {
  assertCan(actor, "settings.update.rules");
  const q = tx.select().from(notePresets);
  return (context ? q.where(eq(notePresets.context, context)) : q).orderBy(
    asc(notePresets.context),
    asc(notePresets.sortOrder),
    asc(notePresets.text),
  );
}

export async function createNotePreset(
  actor: Actor,
  tx: Tx,
  input: { context: NotePresetContext; text: string; sortOrder?: number },
): Promise<NotePreset> {
  assertCan(actor, "settings.update.rules");
  if (!NOTE_PRESET_CONTEXTS.includes(input.context)) throw new ValidationError("Preset context is not valid.");
  const text = input.text.trim();
  if (!text) throw new ValidationError("Preset text is required.");
  const [row] = await tx
    .insert(notePresets)
    .values({ context: input.context, text, sortOrder: input.sortOrder ?? 0 })
    .returning();
  await recordAudit(tx, { actor, action: "note_preset.create", entityType: "note_preset", entityId: row.id, before: null, after: row });
  return row;
}

export async function updateNotePreset(
  actor: Actor,
  tx: Tx,
  id: string,
  input: { text?: string; sortOrder?: number },
): Promise<NotePreset> {
  assertCan(actor, "settings.update.rules");
  const before = await getPreset(tx, id);
  const patch: { text?: string; sortOrder?: number } = {};
  if (input.text !== undefined) {
    const text = input.text.trim();
    if (!text) throw new ValidationError("Preset text is required.");
    patch.text = text;
  }
  if (input.sortOrder !== undefined) patch.sortOrder = input.sortOrder;
  if (!Object.keys(patch).length) return before;
  const [after] = await tx.update(notePresets).set(patch).where(eq(notePresets.id, id)).returning();
  await recordAudit(tx, { actor, action: "note_preset.update", entityType: "note_preset", entityId: id, before, after });
  return after;
}

export async function setNotePresetActive(actor: Actor, tx: Tx, id: string, active: boolean): Promise<NotePreset> {
  assertCan(actor, "settings.update.rules");
  const before = await getPreset(tx, id);
  if (before.active === active) return before;
  const [after] = await tx.update(notePresets).set({ active }).where(eq(notePresets.id, id)).returning();
  await recordAudit(tx, {
    actor,
    action: `note_preset.${active ? "activate" : "deactivate"}`,
    entityType: "note_preset",
    entityId: id,
    before,
    after,
  });
  return after;
}
