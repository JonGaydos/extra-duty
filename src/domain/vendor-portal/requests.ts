import { and, asc, eq, inArray } from "drizzle-orm";
import type { Tx } from "@/db/client";
import {
  assignments,
  jobAttachments,
  jobChangeRequests,
  jobPositions,
  jobs,
  positionTypes,
  users,
  vendorLocations,
  vendors,
} from "@/db/schema";
import type { Actor } from "../actor";
import { recordAudit } from "../audit/audit";
import { changeRequestVendorId, jobVendorId } from "../auth/scope";
import { assertCan, type Action } from "../auth/policy";
import { NotFoundError, RuleViolation, ValidationError, type CheckResult } from "../errors";
import { uploadFile } from "../files/files";
import { createJobsOnDates } from "../jobs/copy";
import {
  jobFieldsFor,
  cancelJobUnchecked,
  createJobInSeries,
  updateJobUnchecked,
  type Job,
  type JobInput,
  type PositionInput,
} from "../jobs/jobs";
import { expandDates, previewBulk, type DateSelection, type TimeOverrides } from "../jobs/recurrence";
import type { SafetyInput } from "../jobs/safety";
import { jobAudience, vendorAudience, vendorStaffAudience } from "../notifications/audiences";
import { emit } from "../notifications/notify";
import { getSettings, type AgencySettings } from "../settings/settings";
import type { ConflictOverride } from "../jobs/schedule-conflicts";
import { AGENCY_TZ, agencyDayKey } from "../time/agency-time";
import type { Cents } from "../types";
import { addVendorContact, type VendorContactInput } from "../vendors/contacts";
import { addLocation, cleanUrl, type LocationInput } from "../vendors/vendors";
import { isJobLocked } from "./holds";
import { VENDOR_FILLED, vendorEditAllowed, type VendorChange } from "./rules";

export { isJobLocked, lockedDetailsForTodo } from "./holds";

export type JobChangeRequest = typeof jobChangeRequests.$inferSelect;

const HOUR_MS = 3_600_000;
const HOLD_MESSAGE = "Vendor on payment hold";
const when = (d: Date) => new Intl.DateTimeFormat("en-US", { timeZone: AGENCY_TZ, dateStyle: "medium", timeStyle: "short" }).format(d);
/** "on <start>" for one detail, or "<n> dates starting <start>" for a series. */
const requestDates = (count: number, start: string) => (count === 1 ? `on ${start}` : `${count} dates starting ${start}`);
const text = (v: string | null | undefined) => (v?.trim() ? v.trim() : null);

function violation(check: CheckResult["check"], message: string): RuleViolation {
  return new RuleViolation([{ check, ok: false, message }], message);
}

async function getJobRow(tx: Tx, id: string): Promise<Job> {
  const [row] = await tx.select().from(jobs).where(eq(jobs.id, id));
  if (!row) throw new NotFoundError("Job not found.");
  return row;
}

/** A vendor user reaching for another vendor's job gets NotFound (no hint it exists); then the policy applies. */
function authorizeJob(actor: Actor, job: Job, action: Action): void {
  // A confidential detail is hidden from its own vendor too (owner decision 2026-11-27).
  if (actor.role === "vendor" && (actor.vendorId !== job.vendorId || job.confidential)) throw new NotFoundError("Job not found.");
  assertCan(actor, action, { vendorId: job.vendorId });
}

async function assertNotOnHold(tx: Tx, vendorId: string): Promise<void> {
  const [v] = await tx.select({ paymentHold: vendors.paymentHold }).from(vendors).where(eq(vendors.id, vendorId));
  if (v?.paymentHold) throw violation("vendor_hold", HOLD_MESSAGE);
}

/** Vendors pick only requestable position types and never set rank or flag overrides. */
async function requestablePositions(tx: Tx, given: PositionInput[]): Promise<PositionInput[]> {
  const ids = [...new Set(given.map((p) => p.positionTypeId))];
  const types = ids.length ? await tx.select().from(positionTypes).where(inArray(positionTypes.id, ids)) : [];
  const byId = new Map(types.map((t) => [t.id, t]));
  for (const p of given) {
    const t = byId.get(p.positionTypeId);
    if (!t?.active) throw new ValidationError("Position type not found.");
    if (!t.vendorRequestable) throw new ValidationError(`${t.name} cannot be requested by a vendor. Call the coordinators.`);
  }
  return given.map((p) => ({ positionTypeId: p.positionTypeId, count: p.count }));
}

// New requests

function assertNotice(starts: Date[], now: Date, hours: number): void {
  const earliest = now.getTime() + hours * HOUR_MS;
  if (starts.some((s) => s.getTime() < earliest)) {
    throw new ValidationError(`Requests need at least ${hours} hours notice. Call the coordinators for anything sooner.`);
  }
}

export type VendorRequestInput = {
  /** Needed only when a coordinator submits for a vendor. */
  vendorId?: string;
  locationId?: string | null;
  newLocation?: LocationInput;
  typeId: string;
  title: string;
  description?: string | null;
  notes?: string | null;
  startAt: Date;
  endAt: Date;
  /** Honored only when the `vendorCanSetRate` setting is on. */
  rateCents?: Cents | null;
  /** Defaults to one position of the default position type. */
  positions?: PositionInput[];
  flex?: Exclude<JobInput["flex"], undefined>;
  /** Look pins up first with resolveSafetyPins, outside the transaction. */
  safety?: SafetyInput;
  contract?: { label: string; url?: string; file?: { body: Buffer; filename: string; contentType: string } };
  contactName?: string | null;
  contactPhone?: string | null;
  /** "Add a new contact": saved to the vendor for future details and copied onto these details. */
  newContact?: VendorContactInput;
  /** One request for many dates; each becomes a requested job in one series. */
  dates?: DateSelection;
  /** Changed clock times for single dates of `dates` (YYYY-MM-DD keys). */
  overrides?: TimeOverrides;
};

/** The vendor the request is for: the vendor's own, or the one a coordinator chose. Refused while inactive or on hold. */
async function requestVendor(actor: Actor, tx: Tx, input: VendorRequestInput): Promise<typeof vendors.$inferSelect> {
  if (actor.role === "vendor" && input.vendorId && input.vendorId !== actor.vendorId) throw new NotFoundError("Vendor not found.");
  const vendorId = actor.role === "vendor" ? actor.vendorId : (input.vendorId ?? null);
  assertCan(actor, "vendorRequest.submit", { vendorId: vendorId ?? undefined });
  if (!vendorId) throw new ValidationError("Choose a vendor.");
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, vendorId));
  if (!vendor) throw new NotFoundError("Vendor not found.");
  if (!vendor.active) throw new ValidationError("That vendor is inactive.");
  if (vendor.paymentHold) throw violation("vendor_hold", HOLD_MESSAGE);
  if (input.locationId && input.newLocation) throw new ValidationError("Pick a location or add a new one, not both.");
  return vendor;
}

/** The positions asked for, or one of the default position type when none were. */
function givenPositions(given: VendorRequestInput["positions"], settings: AgencySettings) {
  if (given?.length) return given;
  if (!settings.defaultPositionTypeId) throw new ValidationError("Add at least one position.");
  return [{ positionTypeId: settings.defaultPositionTypeId, count: 1 }];
}

/** The request's contract: a stored file or a link, with its label. */
async function requestContract(
  actor: Actor,
  tx: Tx,
  input: NonNullable<VendorRequestInput["contract"]>,
): Promise<{ label: string; fileId: string | null; url: string | null }> {
  const label = input.label?.trim();
  if (!label) throw new ValidationError("A contract needs a label.");
  if (!!input.file === !!input.url) throw new ValidationError("Attach a contract file or a link, not both and not neither.");
  if (input.file) {
    const f = await uploadFile(actor, tx, { kind: "contract", ...input.file });
    return { label, fileId: f.id, url: null };
  }
  return { label, fileId: null, url: cleanUrl(input.url!) };
}

/**
 * A vendor (or a coordinator for it) asks for a detail. The jobs start `requested` and go to the
 * coordinators; refused inside the minimum notice, for unrequestable positions and while the vendor is on hold.
 */
export async function submitRequest(actor: Actor, tx: Tx, input: VendorRequestInput, now: Date = new Date()): Promise<Job[]> {
  const vendor = await requestVendor(actor, tx, input);
  const vendorId = vendor.id;

  const settings = await getSettings(tx);
  const dates = input.dates ? expandDates(input.dates, agencyDayKey(input.startAt)) : null;
  const starts = dates ? previewBulk(input, dates, input.overrides, settings).map((p) => p.startAt) : [input.startAt];
  // Coordinators submitting for a vendor are not held to the vendor notice.
  if (actor.role === "vendor") assertNotice(starts, now, settings.vendorMinNoticeHours);

  const positions = await requestablePositions(tx, givenPositions(input.positions, settings));

  let locationId = input.locationId ?? null;
  if (input.newLocation) locationId = (await addLocation(actor, tx, vendorId, input.newLocation)).id;
  const contact = input.newContact ? await addVendorContact(actor, tx, vendorId, input.newContact) : null;

  const contract = input.contract ? await requestContract(actor, tx, input.contract) : null;

  const job: JobInput = {
    vendorId,
    locationId,
    typeId: input.typeId,
    title: input.title,
    description: input.description ?? null,
    notes: input.notes ?? null,
    startAt: input.startAt,
    endAt: input.endAt,
    rateCents: settings.vendorCanSetRate ? (input.rateCents ?? null) : null,
    positions,
    opsPlanRequired: false,
    opsPlanDueAt: null,
    contactName: contact ? contact.name : (input.contactName ?? null),
    contactPhone: contact ? contact.phone : (input.contactPhone ?? null),
    held: false,
    flex: input.flex ?? null,
    safety: input.safety,
  };
  const create = { authorized: true, state: "requested" as const, requestedByUserId: actor.userId };
  const created = dates
    ? await createJobsOnDates(actor, tx, job, dates, input.overrides, { create })
    : [await createJobInSeries(actor, tx, job, null, create)];
  if (contract) {
    await tx.insert(jobAttachments).values(created.map((j) => ({ jobId: j.id, label: contract.label, fileId: contract.fileId, url: contract.url, isContract: true })));
  }

  const first = created[0];
  await emit(tx, {
    recipients: (await vendorStaffAudience(tx, first.vendorId)).filter((u) => u !== actor.userId),
    type: "vendor.request_submitted",
    title: `Vendor request: ${vendor.name}`,
    body: `${first.title}, ${requestDates(created.length, when(first.startAt))}.`,
    link: `/jobs/${first.id}`,
  });
  return created;
}

/** The still-requested jobs of the same request (its whole series, or the one job), locked for the decision. */
async function requestSet(tx: Tx, jobId: string): Promise<Job[]> {
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job) throw new NotFoundError("Job not found.");
  if (job.state !== "requested") throw new ValidationError("This request was already decided.");
  if (!job.seriesId) return [job];
  return tx
    .select()
    .from(jobs)
    .where(and(eq(jobs.seriesId, job.seriesId), eq(jobs.state, "requested")))
    .orderBy(asc(jobs.startAt), asc(jobs.id))
    .for("update");
}

/** Approves the whole request (every date). `edits` apply to each job; times can change only on a single-date request. */
export async function approveRequest(actor: Actor, tx: Tx, jobId: string, edits?: Partial<JobInput>): Promise<Job[]> {
  assertCan(actor, "vendorRequest.decide", { vendorId: await jobVendorId(tx, jobId) });
  const set = await requestSet(tx, jobId);
  const hasEdits = !!edits && Object.keys(edits).length > 0;
  if (hasEdits && set.length > 1 && (edits.startAt !== undefined || edits.endAt !== undefined || edits.flex !== undefined)) {
    throw new ValidationError("Change times one detail at a time.");
  }
  const out: Job[] = [];
  // Sequential: each detail is approved with its writes and audit in this transaction.
  for (const j of set) {
    if (hasEdits) await updateJobUnchecked(actor, tx, j.id, edits, "one");
    const [before] = await tx.select().from(jobs).where(eq(jobs.id, j.id));
    const [after] = await tx.update(jobs).set({ state: "scheduled" }).where(eq(jobs.id, j.id)).returning();
    await recordAudit(tx, { actor, action: "job.request_approve", entityType: "job", entityId: j.id, before, after });
    out.push(after);
  }
  await emit(tx, {
    recipients: await vendorAudience(tx, out[0].vendorId),
    type: "vendor.request_decided",
    title: `Request approved: #${out[0].number} ${out[0].title}`,
    body: out.length === 1 ? `Approved for ${when(out[0].startAt)}.` : `Approved for ${out.length} dates starting ${when(out[0].startAt)}.`,
    link: `/jobs/${out[0].id}`,
  });
  return out;
}

export async function declineRequest(actor: Actor, tx: Tx, jobId: string, reason: string): Promise<Job[]> {
  assertCan(actor, "vendorRequest.decide", { vendorId: await jobVendorId(tx, jobId) });
  const why = reason?.trim();
  if (!why) throw new ValidationError("A reason is required to decline a request.");
  const set = await requestSet(tx, jobId);
  const out: Job[] = [];
  // Sequential: each detail is declined with its writes and audit in this transaction.
  for (const j of set) {
    const [after] = await tx.update(jobs).set({ state: "declined", cancelReason: why }).where(eq(jobs.id, j.id)).returning();
    await recordAudit(tx, { actor, action: "job.request_decline", entityType: "job", entityId: j.id, before: j, after, reason: why });
    out.push(after);
  }
  await emit(tx, {
    recipients: await vendorAudience(tx, out[0].vendorId),
    type: "vendor.request_decided",
    title: `Request declined: #${out[0].number} ${out[0].title}`,
    body: `The coordinators declined this request: ${why}`,
    link: `/jobs/${out[0].id}`,
  });
  return out;
}

// Edits to approved details

export type VendorEditPatch = {
  startAt?: Date;
  endAt?: Date;
  description?: string | null;
  notes?: string | null;
  /** The full list of positions wanted. */
  positions?: PositionInput[];
};
export type VendorEditResult = { applied: true; job: Job } | { applied: false; request: JobChangeRequest };

type StoredPatch = { startAt?: string; endAt?: string; description?: string | null; notes?: string | null; positions?: PositionInput[] };

const toStored = (p: VendorEditPatch): StoredPatch => ({
  ...(p.startAt ? { startAt: p.startAt.toISOString() } : {}),
  ...(p.endAt ? { endAt: p.endAt.toISOString() } : {}),
  ...(p.description !== undefined ? { description: p.description } : {}),
  ...(p.notes !== undefined ? { notes: p.notes } : {}),
  ...(p.positions ? { positions: p.positions } : {}),
});

const fromStored = (p: StoredPatch): Partial<JobInput> => ({
  ...(p.startAt ? { startAt: new Date(p.startAt) } : {}),
  ...(p.endAt ? { endAt: new Date(p.endAt) } : {}),
  ...(p.description !== undefined ? { description: p.description } : {}),
  ...(p.notes !== undefined ? { notes: p.notes } : {}),
  ...(p.positions ? { positions: p.positions } : {}),
});

async function currentPositions(tx: Tx, jobId: string) {
  return tx.select().from(jobPositions).where(eq(jobPositions.jobId, jobId)).orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
}

async function classify(tx: Tx, job: Job, patch: VendorEditPatch): Promise<VendorChange[]> {
  const changes: VendorChange[] = [];
  const startMoved = patch.startAt !== undefined && patch.startAt.getTime() !== job.startAt.getTime();
  const endMoved = patch.endAt !== undefined && patch.endAt.getTime() !== job.endAt.getTime();
  if (startMoved || endMoved) {
    const dayMoved =
      (patch.startAt !== undefined && agencyDayKey(patch.startAt) !== agencyDayKey(job.startAt)) ||
      (patch.endAt !== undefined && agencyDayKey(patch.endAt) !== agencyDayKey(job.endAt));
    changes.push(dayMoved ? "date" : "time");
  }
  if (patch.positions) {
    const total = (list: Array<{ positionTypeId: string; count: number }>) => {
      const m = new Map<string, number>();
      for (const p of list) m.set(p.positionTypeId, (m.get(p.positionTypeId) ?? 0) + p.count);
      return m;
    };
    const was = total(await currentPositions(tx, job.id));
    const wants = total(patch.positions);
    const types = new Set([...was.keys(), ...wants.keys()]);
    if ([...types].some((t) => (wants.get(t) ?? 0) > (was.get(t) ?? 0))) changes.push("headcount_up");
    if ([...types].some((t) => (wants.get(t) ?? 0) < (was.get(t) ?? 0))) changes.push("headcount_down");
  }
  if ((patch.description !== undefined && text(patch.description) !== job.description) || (patch.notes !== undefined && text(patch.notes) !== job.notes)) {
    changes.push("description");
  }
  return changes;
}

/** Applies a patch to a job. A time change alerts through updateJob; headcount and description alert here. */
async function applyPatch(actor: Actor, tx: Tx, job: Job, patch: Partial<JobInput>, changes: VendorChange[]): Promise<Job> {
  const [after] = await updateJobUnchecked(actor, tx, job.id, patch, "one");
  const details: string[] = [];
  if (changes.some((c) => c === "headcount_up" || c === "headcount_down")) details.push("The number of positions changed.");
  if (changes.includes("description")) details.push("The description or notes changed.");
  if (details.length && after.state !== "requested") {
    await emit(tx, { recipients: await jobAudience(tx, after), type: "job.changed", title: `Detail changed: #${after.number} ${after.title}`, body: details.join(" "), link: `/jobs/${after.id}` });
  }
  return after;
}

type EditChange = Awaited<ReturnType<typeof classify>>[number];

/** A still-requested detail: a vendor's edit is held to the request rules and notice, then applied, and the coordinators are told. */
async function editRequest(actor: Actor, tx: Tx, job: Job, clean: VendorEditPatch, changes: EditChange[], now: Date): Promise<VendorEditResult> {
  if (actor.role === "vendor") {
    const settings = await getSettings(tx);
    for (const change of changes) {
      const r = vendorEditAllowed({ now, job: { startAt: job.startAt, signedUpCount: 0 }, change, s: settings });
      if (!r.allowed) throw violation("vendor.edit", r.reason ?? "This change is not allowed.");
    }
    if (clean.startAt) assertNotice([clean.startAt], now, settings.vendorMinNoticeHours);
  }
  const after = await applyPatch(actor, tx, job, fromStored(toStored(clean)), changes);
  await emit(tx, {
    recipients: (await vendorStaffAudience(tx, after.vendorId)).filter((u) => u !== actor.userId),
    type: "vendor.request_edited",
    title: `Vendor request edited: #${after.number} ${after.title}`,
    body: `The request now starts ${when(after.startAt)}.`,
    link: `/jobs/${after.id}`,
  });
  return { applied: true, job: jobFieldsFor(actor, after) };
}

/** Whether a vendor's change to a scheduled detail needs a coordinator's approval; a change the rules refuse throws. */
async function vendorChangeNeedsApproval(tx: Tx, job: Job, changes: EditChange[], now: Date): Promise<boolean> {
  const settings = await getSettings(tx);
  const held = await tx
    .select({ id: assignments.id })
    .from(assignments)
    .where(and(eq(assignments.jobId, job.id), inArray(assignments.status, ["signed_up", "pending_short"])));
  let needsApproval = false;
  for (const change of changes) {
    const r = vendorEditAllowed({ now, job: { startAt: job.startAt, signedUpCount: held.length }, change, s: settings });
    if (!r.allowed) throw violation("vendor.edit", r.reason ?? "This change is not allowed.");
    needsApproval ||= r.needsApproval;
  }
  return needsApproval;
}

/**
 * A vendor edit of its own detail. Inside the admin settings it applies at once (description) or becomes a
 * pending change for a coordinator (time, date, headcount); a coordinator acting for the vendor applies directly.
 * A request still waiting for approval changes in place and the coordinators are told.
 */
export async function vendorEditJob(actor: Actor, tx: Tx, jobId: string, patch: VendorEditPatch, now: Date = new Date()): Promise<VendorEditResult> {
  const job = await getJobRow(tx, jobId);
  authorizeJob(actor, job, "vendorJob.edit");
  if (job.state === "canceled" || job.state === "declined") throw new ValidationError("A canceled or declined detail cannot be changed.");
  const vendorActor = actor.role === "vendor";
  if (vendorActor) await assertNotOnHold(tx, job.vendorId);
  const clean: VendorEditPatch = { ...patch, positions: patch.positions && vendorActor ? await requestablePositions(tx, patch.positions) : patch.positions };
  const changes = await classify(tx, job, clean);
  if (changes.length === 0) return { applied: true, job: jobFieldsFor(actor, job) };

  if (job.state === "requested") return editRequest(actor, tx, job, clean, changes, now);

  const needsApproval = vendorActor && (await vendorChangeNeedsApproval(tx, job, changes, now));
  if (!needsApproval) return { applied: true, job: jobFieldsFor(actor, await applyPatch(actor, tx, job, fromStored(toStored(clean)), changes)) };

  const [request] = await tx.insert(jobChangeRequests).values({ jobId: job.id, requestedBy: actor.userId, patch: toStored(clean) }).returning();
  await recordAudit(tx, { actor, action: "job.change_request", entityType: "job", entityId: job.id, before: null, after: request });
  await emit(tx, {
    recipients: await vendorStaffAudience(tx, job.vendorId),
    type: "vendor.request_edited",
    title: `Vendor change to approve: #${job.number} ${job.title}`,
    body: `The vendor asks to change ${changes.map((c) => c.replace("_", " ")).join(", ")}.`,
    link: `/jobs/${job.id}`,
  });
  return { applied: false, request };
}

async function pendingChange(tx: Tx, id: string): Promise<JobChangeRequest> {
  const [row] = await tx.select().from(jobChangeRequests).where(eq(jobChangeRequests.id, id)).for("update");
  if (!row) throw new NotFoundError("Change request not found.");
  if (row.status !== "pending") throw new ValidationError("This change was already decided.");
  return row;
}

/** Applies the vendor's pending change and alerts the people on the job. */
/** `conflictOverride`: a coordinator's override of the deputy conflicts the change was shown to cause. */
export async function approveJobChange(actor: Actor, tx: Tx, requestId: string, now: Date = new Date(), opts: { conflictOverride?: ConflictOverride | null } = {}): Promise<Job> {
  assertCan(actor, "vendorRequest.decide", { vendorId: await changeRequestVendorId(tx, requestId) });
  const row = await pendingChange(tx, requestId);
  const job = await getJobRow(tx, row.jobId);
  if (job.state === "canceled" || job.state === "declined") throw new ValidationError("A canceled or declined detail cannot be changed.");
  const stored = row.patch as StoredPatch;
  const patch = fromStored(stored);
  const changes = await classify(tx, job, { ...patch, positions: stored.positions });
  const after = await applyPatch(actor, tx, job, { ...patch, conflictOverride: opts.conflictOverride ?? null }, changes);
  const [done] = await tx.update(jobChangeRequests).set({ status: "approved", decidedBy: actor.userId, decidedAt: now }).where(eq(jobChangeRequests.id, row.id)).returning();
  await recordAudit(tx, { actor, action: "job.change_approve", entityType: "job", entityId: job.id, before: row, after: done });
  await emit(tx, {
    recipients: await vendorAudience(tx, job.vendorId),
    type: "vendor.request_decided",
    title: `Change approved: #${job.number} ${job.title}`,
    body: "The coordinators approved your change.",
    link: `/jobs/${job.id}`,
  });
  return after;
}

export async function declineJobChange(actor: Actor, tx: Tx, requestId: string, reason: string, now: Date = new Date()): Promise<JobChangeRequest> {
  assertCan(actor, "vendorRequest.decide", { vendorId: await changeRequestVendorId(tx, requestId) });
  const why = reason?.trim();
  if (!why) throw new ValidationError("A reason is required to decline a change.");
  const row = await pendingChange(tx, requestId);
  const job = await getJobRow(tx, row.jobId);
  const [done] = await tx.update(jobChangeRequests).set({ status: "declined", decidedBy: actor.userId, decidedAt: now, reason: why }).where(eq(jobChangeRequests.id, row.id)).returning();
  await recordAudit(tx, { actor, action: "job.change_decline", entityType: "job", entityId: job.id, before: row, after: done, reason: why });
  await emit(tx, {
    recipients: await vendorAudience(tx, job.vendorId),
    type: "vendor.request_decided",
    title: `Change declined: #${job.number} ${job.title}`,
    body: `The coordinators declined your change: ${why}`,
    link: `/jobs/${job.id}`,
  });
  return done;
}

// Cancellation and late cancellation pay

/**
 * The vendor, or a coordinator for it, cancels a detail. Vendors cancel until `vendorCancelUntilHours` before
 * the start; coordinators any time before it. Inside `lateVendorCancelHours` every signed-up person is paid:
 * their assignment becomes late_canceled and bills at once.
 */
export async function vendorCancelJob(actor: Actor, tx: Tx, jobId: string, reason: string, now: Date = new Date()): Promise<Job> {
  const job = await getJobRow(tx, jobId);
  authorizeJob(actor, job, "vendorJob.cancel");
  const why = reason?.trim();
  if (!why) throw new ValidationError("A cancellation reason is required.");
  if (job.state === "canceled" || job.state === "declined") throw new ValidationError("This job is already closed.");
  if (job.state !== "requested") {
    if (actor.role === "vendor") {
      const r = vendorEditAllowed({ now, job: { startAt: job.startAt, signedUpCount: 0 }, change: "cancel", s: await getSettings(tx) });
      if (!r.allowed) throw violation("vendor.cancel", r.reason ?? "This detail cannot be canceled.");
    } else if (now.getTime() >= job.startAt.getTime()) {
      throw new ValidationError("This detail has started and can no longer be canceled.");
    }
  }
  return cancelJobUnchecked(actor, tx, jobId, why, { cause: "vendor", now });
}

/** Coordinators and admins. Unbilled late cancellations become plain cancellations; the people are told. */
export async function waiveLateCancelPay(actor: Actor, tx: Tx, jobId: string, reason: string): Promise<Array<typeof assignments.$inferSelect>> {
  assertCan(actor, "lateCancel.waive");
  const why = reason?.trim();
  if (!why) throw new ValidationError("A reason is required to waive late cancellation pay.");
  const job = await getJobRow(tx, jobId);
  if (job.state !== "canceled") throw new ValidationError("Only a canceled detail has late cancellation pay.");
  const waived = await tx
    .update(assignments)
    .set({ status: "canceled", removalReason: "Late cancellation pay waived" })
    .where(and(eq(assignments.jobId, jobId), eq(assignments.status, "late_canceled")))
    .returning();
  await tx.update(jobs).set({ lateCancelWaivedReason: why }).where(eq(jobs.id, jobId));
  // Sequential: writes and alerts in this transaction.
  for (const a of waived) {
    await recordAudit(tx, { actor, action: "assignment.late_cancel_waive", entityType: "assignment", entityId: a.id, before: { ...a, status: "late_canceled" }, after: a, reason: why });
  }
  await recordAudit(tx, { actor, action: "job.late_cancel_waive", entityType: "job", entityId: jobId, before: job, after: { ...job, lateCancelWaivedReason: why }, reason: why });
  await emit(tx, {
    recipients: waived.map((a) => a.userId),
    type: "job.late_cancel_waived",
    title: `Late cancellation pay waived: #${job.number} ${job.title}`,
    body: `A coordinator waived the late cancellation pay for this detail: ${why}`,
    link: `/jobs/${jobId}`,
  });
  return waived;
}

// The vendor's view

export type VendorJobView = {
  id: string;
  number: number;
  title: string;
  description: string | null;
  notes: string | null;
  state: Job["state"];
  startAt: Date;
  endAt: Date;
  location: { id: string; name: string; address: string | null; lat: number | null; lng: number | null } | null;
  /** The vendor's account is on payment hold. */
  onHold: boolean;
  positions: Array<{
    id: string;
    name: string;
    count: number;
    filled: number;
    /** Full names with planned times; null until the detail is filled (or when the setting is off). */
    assigned: Array<{ name: string; plannedStartAt: Date; plannedEndAt: Date }> | null;
  }>;
  contracts: Array<{ id: string; label: string; url: string | null; fileId: string | null }>;
};

/**
 * What a vendor sees of its own detail. Never phone, email, flags or qualifications of personnel; names
 * only once every spot is filled and `vendorSeesAssignedNames` is on. A vendor on payment hold cannot open its
 * upcoming details.
 */
export async function vendorViewJob(actor: Actor, tx: Tx, jobId: string, now: Date = new Date()): Promise<VendorJobView> {
  const job = await getJobRow(tx, jobId);
  authorizeJob(actor, job, "vendorJob.view");
  const locked = await isJobLocked(tx, jobId);
  if (actor.role === "vendor" && locked && job.endAt.getTime() > now.getTime()) throw violation("vendor_hold", HOLD_MESSAGE);
  const settings = await getSettings(tx);
  const positions = await tx
    .select({ p: jobPositions, name: positionTypes.name })
    .from(jobPositions)
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(eq(jobPositions.jobId, jobId))
    .orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const people = await tx
    .select({ a: assignments, name: users.name })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(eq(assignments.jobId, jobId), inArray(assignments.status, [...VENDOR_FILLED])))
    .orderBy(asc(assignments.createdAt), asc(assignments.id));
  const filledAll = positions.every(({ p }) => people.filter((x) => x.a.jobPositionId === p.id).length >= p.count);
  const showNames = filledAll && settings.vendorSeesAssignedNames;
  const [loc] = job.locationId ? await tx.select().from(vendorLocations).where(eq(vendorLocations.id, job.locationId)) : [];
  const contracts = await tx
    .select()
    .from(jobAttachments)
    .where(and(eq(jobAttachments.jobId, jobId), eq(jobAttachments.isContract, true)))
    .orderBy(asc(jobAttachments.createdAt), asc(jobAttachments.id));
  return {
    id: job.id,
    number: job.number,
    title: job.title,
    description: job.description,
    notes: job.notes,
    state: job.state,
    startAt: job.startAt,
    endAt: job.endAt,
    location: loc ? { id: loc.id, name: loc.name, address: loc.address, lat: loc.lat, lng: loc.lng } : null,
    onHold: locked,
    positions: positions.map(({ p, name }) => {
      const mine = people.filter((x) => x.a.jobPositionId === p.id);
      return {
        id: p.id,
        name,
        count: p.count,
        filled: mine.length,
        assigned: showNames ? mine.map((x) => ({ name: x.name, plannedStartAt: x.a.plannedStartAt ?? job.startAt, plannedEndAt: x.a.plannedEndAt ?? job.endAt })) : null,
      };
    }),
    contracts: contracts.map((c) => ({ id: c.id, label: c.label, url: c.url, fileId: c.fileId })),
  };
}
