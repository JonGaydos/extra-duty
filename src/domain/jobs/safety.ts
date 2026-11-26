import { asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { jobSafety, jobSafetyAddresses, users } from "@/db/schema";
import type { Actor, Role } from "../actor";
import { recordAudit } from "../audit/audit";
import { ValidationError } from "../errors";
import { geocodeAddress } from "../vendors/geocode";

type SafetyAddressInput = {
  address: string;
  description: string;
  /** Leave undefined to look the address up; null means the lookup already failed. */
  lat?: number | null;
  lng?: number | null;
  /** Where sent coordinates came from: the field's lookup (auto) or placed by hand (manual, the default). */
  source?: "auto" | "manual";
  /** Set by resolveSafetyPins on a point it looked up itself; such a point never replaces a stored pin. */
  lookedUp?: boolean;
};
export type SafetyInput = { notes: string; addresses: SafetyAddressInput[] };

type Stamp = {
  addedBy: string | null;
  addedByName: string | null;
  addedByRole: Role | null;
  addedAt: Date;
  editedBy: string | null;
  editedByName: string | null;
  editedByRole: Role | null;
  editedAt: Date | null;
};

type SafetyAddress = Stamp & {
  id: string;
  address: string;
  description: string | null;
  lat: number | null;
  lng: number | null;
  source: "auto" | "manual";
};

export type JobSafetyView = Stamp & { notes: string | null; addresses: SafetyAddress[] };

const MAX_SAFETY_ADDRESSES = 10;

function assertCount(n: number): void {
  if (n > MAX_SAFETY_ADDRESSES) throw new ValidationError(`A job can hold at most ${MAX_SAFETY_ADDRESSES} safety addresses.`);
}

const norm = (s: string) => s.trim().replace(/\s+/g, " ").toLowerCase();
const clean = (s: string | undefined | null) => (s?.trim() ? s.trim() : null);

/**
 * Looks up pins for addresses that have none yet. Call it before opening the
 * database transaction so a slow lookup never holds a connection; a failed
 * lookup yields a null pin and the address is still saved.
 */
export async function resolveSafetyPins(safety: SafetyInput): Promise<SafetyInput> {
  assertCount(safety.addresses.length);
  const addresses: SafetyAddressInput[] = [];
  // Sequential: the geocoder allows one lookup at a time.
  for (const a of safety.addresses) {
    if (a.lat !== undefined && a.lng !== undefined) {
      const bad = (n: number | null, max: number) => n !== null && (typeof n !== "number" || !Number.isFinite(n) || Math.abs(n) > max);
      if (bad(a.lat, 90) || bad(a.lng, 180) || (a.lat === null) !== (a.lng === null)) throw new ValidationError("The pin position is not valid.");
      addresses.push({ ...a, source: a.source === "auto" ? "auto" : "manual", lookedUp: false });
      continue;
    }
    const pin = await geocodeAddress(a.address);
    addresses.push({ ...a, lat: pin?.lat ?? null, lng: pin?.lng ?? null, source: "auto", lookedUp: true });
  }
  return { ...safety, addresses };
}

/** Adds, or edits, the safety notes; true when they changed. */
async function saveSafetyNotes(actor: Actor, tx: Tx, jobId: string, row: typeof jobSafety.$inferSelect | undefined, notes: string | null, now: Date): Promise<boolean> {
  if (!row) {
    if (notes === null) return false;
    await tx.insert(jobSafety).values({ jobId, notes, addedBy: actor.userId, addedAt: now });
    return true;
  }
  if ((row.notes ?? null) === notes) return false;
  await tx.update(jobSafety).set({ notes, editedBy: actor.userId, editedAt: now }).where(eq(jobSafety.id, row.id));
  return true;
}

/** Saves a kept address's new description or sent pin; true when it changed. */
async function updateSafetyAddress(actor: Actor, tx: Tx, match: typeof jobSafetyAddresses.$inferSelect, a: SafetyAddressInput, now: Date): Promise<boolean> {
  const description = clean(a.description);
  // Only a point the caller sent replaces the stored pin; a point looked up here (nothing sent) never does,
  // so a hand-placed pin survives a save that carries no coordinates.
  const sent = !a.lookedUp && typeof a.lat === "number" && typeof a.lng === "number";
  const source = a.source === "auto" ? "auto" : "manual";
  const moved = sent && (a.lat !== match.lat || a.lng !== match.lng || source !== match.geocodeSource);
  if ((match.description ?? null) === description && !moved) return false;
  await tx
    .update(jobSafetyAddresses)
    .set({ description, ...(moved ? { lat: a.lat, lng: a.lng, geocodeSource: source } : {}), editedBy: actor.userId, editedAt: now })
    .where(eq(jobSafetyAddresses.id, match.id));
  return true;
}

/** Adds a new address, looking up its pin when none was sent. */
async function insertSafetyAddress(actor: Actor, tx: Tx, jobId: string, a: SafetyAddressInput, now: Date): Promise<void> {
  let lat = a.lat;
  let lng = a.lng;
  let source: "auto" | "manual" = a.lookedUp || a.source === "auto" ? "auto" : "manual";
  if (lat === undefined || lng === undefined) {
    const pin = await geocodeAddress(a.address);
    lat = pin?.lat ?? null;
    lng = pin?.lng ?? null;
    source = "auto";
  }
  await tx.insert(jobSafetyAddresses).values({
    jobId,
    address: a.address.trim(),
    description: clean(a.description),
    lat,
    lng,
    geocodeSource: lat === null ? "auto" : source,
    addedBy: actor.userId,
    addedAt: now,
  });
}

/**
 * Brings a job's safety record in line with `input`. Returns whether anything
 * changed. Edits stamp editedBy/editedAt; earlier text and removed addresses
 * survive in the audit row.
 */
export async function applySafety(actor: Actor, tx: Tx, jobId: string, input: SafetyInput): Promise<boolean> {
  const [row] = await tx.select().from(jobSafety).where(eq(jobSafety.jobId, jobId));
  const existing = await tx
    .select()
    .from(jobSafetyAddresses)
    .where(eq(jobSafetyAddresses.jobId, jobId))
    .orderBy(asc(jobSafetyAddresses.createdAt), asc(jobSafetyAddresses.id));
  const now = new Date();
  const notes = clean(input.notes);
  let changed = await saveSafetyNotes(actor, tx, jobId, row, notes, now);

  const wanted = input.addresses.filter((a) => a.address.trim());
  assertCount(wanted.length);
  const keep = new Set<string>();
  // Sequential: each address is matched against the ones kept before it, and writes share this transaction.
  for (const a of wanted) {
    const key = norm(a.address);
    const match = existing.find((e) => !keep.has(e.id) && norm(e.address) === key);
    if (match) {
      keep.add(match.id);
      if (await updateSafetyAddress(actor, tx, match, a, now)) changed = true;
      continue;
    }
    await insertSafetyAddress(actor, tx, jobId, a, now);
    changed = true;
  }
  const removed = existing.filter((e) => !keep.has(e.id));
  if (removed.length) {
    await tx.delete(jobSafetyAddresses).where(
      inArray(
        jobSafetyAddresses.id,
        removed.map((r) => r.id),
      ),
    );
    changed = true;
  }

  if (changed) {
    await recordAudit(tx, {
      actor,
      action: "job.safety_update",
      entityType: "job",
      entityId: jobId,
      before: { notes: row?.notes ?? null, addresses: existing.map((e) => ({ address: e.address, description: e.description })) },
      after: { notes, addresses: wanted.map((a) => ({ address: a.address.trim(), description: clean(a.description) })) },
    });
  }
  return changed;
}

/** Safety notes and addresses with who added and last edited each. Null when the job has none. */
export async function loadSafety(tx: Tx, jobId: string): Promise<JobSafetyView | null> {
  const [row] = await tx.select().from(jobSafety).where(eq(jobSafety.jobId, jobId));
  const addrs = await tx
    .select()
    .from(jobSafetyAddresses)
    .where(eq(jobSafetyAddresses.jobId, jobId))
    .orderBy(asc(jobSafetyAddresses.createdAt), asc(jobSafetyAddresses.id));
  if (!row && addrs.length === 0) return null;

  const ids = new Set<string>();
  for (const r of [row, ...addrs]) {
    if (r?.addedBy) ids.add(r.addedBy);
    if (r?.editedBy) ids.add(r.editedBy);
  }
  const people = ids.size
    ? await tx.select({ id: users.id, name: users.name, role: users.role }).from(users).where(inArray(users.id, [...ids]))
    : [];
  const who = new Map(people.map((p) => [p.id, p]));
  const name = (id: string | null) => (id ? (who.get(id)?.name ?? null) : null);
  const role = (id: string | null): Role | null => (id ? (who.get(id)?.role ?? null) : null);

  const stamp = (r: { addedBy: string | null; addedAt: Date; editedBy: string | null; editedAt: Date | null }): Stamp => ({
    addedBy: r.addedBy,
    addedByName: name(r.addedBy),
    addedByRole: role(r.addedBy),
    addedAt: r.addedAt,
    editedBy: r.editedBy,
    editedByName: name(r.editedBy),
    editedByRole: role(r.editedBy),
    editedAt: r.editedAt,
  });
  return {
    notes: row?.notes ?? null,
    ...stamp(row ?? addrs[0]),
    addresses: addrs.map((a) => ({
      id: a.id,
      address: a.address,
      description: a.description,
      lat: a.lat,
      lng: a.lng,
      source: a.geocodeSource,
      ...stamp(a),
    })),
  };
}
