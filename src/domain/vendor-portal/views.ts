import { and, asc, desc, eq, gte, inArray, isNotNull, lte } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoices, jobChangeRequests, jobPositions, jobTypes, jobs, paymentMethods, positionTypes, users, vendorContacts, vendorLocations, vendors } from "@/db/schema";
import type { Actor } from "../actor";
import { assertCan } from "../auth/policy";
import { ForbiddenError, NotFoundError } from "../errors";
import { formatInvoiceNumber } from "../invoices/invoices";
import { getSettings } from "../settings/settings";
import type { Cents, Minutes } from "../types";
import { VENDOR_FILLED, vendorEditAllowed, type EditDecision } from "./rules";

/** Read models for the vendor portal screens. Vendor users only, and only their own vendor's rows. */

const HOLDING = ["signed_up", "pending_short"] as const;
const HOUR_MS = 3_600_000;

function ownVendor(actor: Actor): string {
  if (actor.role !== "vendor" || !actor.vendorId) throw new ForbiddenError();
  assertCan(actor, "vendorJob.view", { vendorId: actor.vendorId });
  return actor.vendorId;
}

export type VendorAccount = { name: string; onHold: boolean };

/** The vendor's name and whether it is on payment hold (it then cannot request or change details). */
export async function vendorAccount(actor: Actor, tx: Tx): Promise<VendorAccount> {
  const vendorId = ownVendor(actor);
  const [v] = await tx.select({ name: vendors.name, onHold: vendors.paymentHold }).from(vendors).where(eq(vendors.id, vendorId));
  if (!v) throw new NotFoundError("Vendor not found.");
  return v;
}

// Details list and calendar

export type VendorDetailStatus = "requested" | "scheduled" | "filled" | "past" | "canceled" | "declined";

export const VENDOR_STATUS_LABEL: Record<VendorDetailStatus, string> = {
  requested: "Requested",
  scheduled: "Scheduled",
  filled: "Filled",
  past: "Past",
  canceled: "Canceled",
  declined: "Declined",
};

export type VendorDetailRow = {
  id: string;
  number: number;
  title: string;
  startAt: Date;
  endAt: Date;
  status: VendorDetailStatus;
  locationName: string | null;
  needed: number;
  filled: number;
  /** A date, time or headcount change is waiting for a coordinator. */
  pendingChange: boolean;
};

export function vendorStatus(job: { state: (typeof jobs.$inferSelect)["state"]; endAt: Date }, needed: number, filled: number, now: Date): VendorDetailStatus {
  if (job.state === "requested" || job.state === "canceled" || job.state === "declined") return job.state;
  if (job.endAt.getTime() <= now.getTime()) return "past";
  return needed > 0 && filled >= needed ? "filled" : "scheduled";
}

/** The vendor's details starting in [from, to], soonest first. */
export async function vendorDetails(actor: Actor, tx: Tx, range: { from: Date; to: Date }, now: Date = new Date()): Promise<VendorDetailRow[]> {
  const vendorId = ownVendor(actor);
  const rows = await tx
    .select({ job: jobs, locationName: vendorLocations.name })
    .from(jobs)
    .leftJoin(vendorLocations, eq(vendorLocations.id, jobs.locationId))
    .where(and(eq(jobs.vendorId, vendorId), gte(jobs.startAt, range.from), lte(jobs.startAt, range.to)))
    .orderBy(asc(jobs.startAt), asc(jobs.number));
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.job.id);
  const positions = await tx.select({ jobId: jobPositions.jobId, count: jobPositions.count }).from(jobPositions).where(inArray(jobPositions.jobId, ids));
  const people = await tx.select({ jobId: assignments.jobId }).from(assignments).where(and(inArray(assignments.jobId, ids), inArray(assignments.status, [...VENDOR_FILLED])));
  const waiting = new Set(
    (await tx.select({ jobId: jobChangeRequests.jobId }).from(jobChangeRequests).where(and(inArray(jobChangeRequests.jobId, ids), eq(jobChangeRequests.status, "pending")))).map((r) => r.jobId),
  );
  return rows.map(({ job, locationName }) => {
    const needed = positions.filter((p) => p.jobId === job.id).reduce((n, p) => n + p.count, 0);
    const filled = people.filter((p) => p.jobId === job.id).length;
    return {
      id: job.id,
      number: job.number,
      title: job.title,
      startAt: job.startAt,
      endAt: job.endAt,
      status: vendorStatus(job, needed, filled, now),
      locationName,
      needed,
      filled,
      pendingChange: waiting.has(job.id),
    };
  });
}

// One detail: what the vendor may change

export type VendorJobControls = {
  /** Current positions, one row per type, for the headcount fields. */
  positions: Array<{ positionTypeId: string; name: string; count: number }>;
  /** Description and notes. */
  edit: { allowed: boolean; reason: string | null };
  /** Date, time and headcount. `positionsOnly`: once someone is signed up, the setting may allow adding positions only. */
  schedule: { allowed: boolean; needsApproval: boolean; reason: string | null; positionsOnly: boolean };
  cancel: { allowed: boolean; reason: string | null; latePay: boolean; lateHours: number };
  pendingChange: { id: string; requestedAt: Date } | null;
  signedUp: number;
};

const refused = (reason: string) => ({ allowed: false, reason });

/** Why the vendor can change nothing on the detail right now, or null when it is open to changes. */
function closedToVendor(job: { state: string; startAt: Date }, hold: boolean, now: Date): string | null {
  if (job.state === "canceled" || job.state === "declined") return "This detail is closed.";
  if (hold) return "Your account is on payment hold, so details cannot be changed. Call the coordinators.";
  if (job.startAt.getTime() <= now.getTime()) return "This detail has started.";
  return null;
}

/**
 * What the vendor may change on its own detail right now, from the vendor settings (edit lock, edits after sign-up,
 * cancellation window) and the rules in `vendorEditAllowed`. Another vendor's job is not found.
 */
export async function vendorJobControls(actor: Actor, tx: Tx, jobId: string, now: Date = new Date()): Promise<VendorJobControls> {
  const vendorId = ownVendor(actor);
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, jobId));
  if (job?.vendorId !== vendorId) throw new NotFoundError("Job not found.");
  const s = await getSettings(tx);
  const posRows = await tx
    .select({ positionTypeId: jobPositions.positionTypeId, name: positionTypes.name, count: jobPositions.count })
    .from(jobPositions)
    .innerJoin(positionTypes, eq(positionTypes.id, jobPositions.positionTypeId))
    .where(eq(jobPositions.jobId, jobId))
    .orderBy(asc(jobPositions.createdAt), asc(jobPositions.id));
  const positions: VendorJobControls["positions"] = [];
  for (const p of posRows) {
    const same = positions.find((x) => x.positionTypeId === p.positionTypeId);
    if (same) same.count += p.count;
    else positions.push({ ...p });
  }
  const held = await tx.select({ id: assignments.id }).from(assignments).where(and(eq(assignments.jobId, jobId), inArray(assignments.status, [...HOLDING])));
  const signedUp = held.length;
  const [pending] = await tx
    .select({ id: jobChangeRequests.id, requestedAt: jobChangeRequests.createdAt })
    .from(jobChangeRequests)
    .where(and(eq(jobChangeRequests.jobId, jobId), eq(jobChangeRequests.status, "pending")))
    .orderBy(desc(jobChangeRequests.createdAt))
    .limit(1);
  const [v] = await tx.select({ hold: vendors.paymentHold }).from(vendors).where(eq(vendors.id, vendorId));
  const lateHours = s.lateVendorCancelHours;
  const base = { positions, signedUp, pendingChange: pending ?? null };

  const closedReason = closedToVendor(job, v?.hold ?? false, now);
  if (closedReason) {
    return { ...base, edit: refused(closedReason), schedule: { ...refused(closedReason), needsApproval: false, positionsOnly: false }, cancel: { ...refused(closedReason), latePay: false, lateHours } };
  }

  const requested = job.state === "requested";
  const decide = (change: "description" | "time" | "headcount_up" | "cancel"): EditDecision =>
    vendorEditAllowed({ now, job: { startAt: job.startAt, signedUpCount: requested ? 0 : signedUp }, change, s });
  const desc_ = decide("description");
  const time = decide("time");
  const more = decide("headcount_up");
  const positionsOnly = !time.allowed && more.allowed;
  const cancel = requested ? { allowed: true, needsApproval: false } : decide("cancel");
  const hoursAhead = (job.startAt.getTime() - now.getTime()) / HOUR_MS;
  return {
    ...base,
    edit: { allowed: desc_.allowed, reason: desc_.allowed ? null : (desc_.reason ?? null) },
    schedule: {
      allowed: time.allowed || positionsOnly,
      needsApproval: !requested && (time.allowed ? time.needsApproval : more.needsApproval),
      reason: time.allowed ? null : (time.reason ?? null),
      positionsOnly,
    },
    cancel: {
      allowed: cancel.allowed,
      reason: cancel.allowed ? null : (cancel.reason ?? null),
      latePay: cancel.allowed && !requested && signedUp > 0 && hoursAhead < lateHours,
      lateHours,
    },
  };
}

// New request form

export type VendorRequestOptions = {
  locations: Array<{ id: string; name: string; address: string | null }>;
  /** The vendor's active site contacts. */
  contacts: Array<{ id: string; name: string; phone: string }>;
  jobTypes: Array<{ id: string; name: string }>;
  positionTypes: Array<{ id: string; name: string }>;
  defaultPositionTypeId: string | null;
  vendorCanSetRate: boolean;
  onHold: boolean;
  rules: { minNoticeHours: number; editLockHours: number; cancelUntilHours: number; lateCancelHours: number; minimumBillableMinutes: Minutes; lateCancelPayBasis: string };
};

/** The vendor's active locations, the active job types and the positions vendors may request, plus the rules to show. */
export async function vendorRequestOptions(actor: Actor, tx: Tx): Promise<VendorRequestOptions> {
  const vendorId = ownVendor(actor);
  const s = await getSettings(tx);
  const [v] = await tx.select({ hold: vendors.paymentHold }).from(vendors).where(eq(vendors.id, vendorId));
  const locations = await tx
    .select({ id: vendorLocations.id, name: vendorLocations.name, address: vendorLocations.address })
    .from(vendorLocations)
    .where(and(eq(vendorLocations.vendorId, vendorId), eq(vendorLocations.active, true)))
    .orderBy(asc(vendorLocations.name));
  const contacts = await tx
    .select({ id: vendorContacts.id, name: vendorContacts.name, phone: vendorContacts.phone })
    .from(vendorContacts)
    .where(and(eq(vendorContacts.vendorId, vendorId), eq(vendorContacts.active, true)))
    .orderBy(asc(vendorContacts.name));
  const types = await tx.select({ id: jobTypes.id, name: jobTypes.name }).from(jobTypes).where(eq(jobTypes.active, true)).orderBy(asc(jobTypes.sortOrder), asc(jobTypes.name));
  const positions = await tx
    .select({ id: positionTypes.id, name: positionTypes.name })
    .from(positionTypes)
    .where(and(eq(positionTypes.active, true), eq(positionTypes.vendorRequestable, true)))
    .orderBy(asc(positionTypes.sortOrder), asc(positionTypes.name));
  return {
    locations,
    contacts,
    jobTypes: types,
    positionTypes: positions,
    defaultPositionTypeId: positions.some((p) => p.id === s.defaultPositionTypeId) ? s.defaultPositionTypeId : (positions[0]?.id ?? null),
    vendorCanSetRate: s.vendorCanSetRate,
    onHold: !!v?.hold,
    rules: {
      minNoticeHours: s.vendorMinNoticeHours,
      editLockHours: s.vendorEditLockHours,
      cancelUntilHours: s.vendorCancelUntilHours,
      lateCancelHours: s.lateVendorCancelHours,
      minimumBillableMinutes: s.minimumBillableMinutes,
      lateCancelPayBasis: s.lateCancelPayBasis,
    },
  };
}

// Invoices

export type VendorInvoiceRow = {
  id: string;
  number: string;
  kind: (typeof invoices.$inferSelect)["kind"];
  status: (typeof invoices.$inferSelect)["status"];
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  jobStartAt: Date;
  payeeName: string;
  minutes: Minutes;
  rateCents: Cents;
  totalCents: Cents;
  sentAt: Date;
  deputyPaidAt: Date | null;
  /** The vendor's own paid note (12.8). */
  vendorPaid: { at: Date; method: string | null; reference: string | null } | null;
};

/** Invoices sent to the vendor, newest first. Invoices still in review or waiting to send are never shown. */
export async function vendorInvoices(actor: Actor, tx: Tx): Promise<VendorInvoiceRow[]> {
  const vendorId = ownVendor(actor);
  const { invoiceNumberPrefix } = await getSettings(tx);
  const rows = await tx
    .select({ inv: invoices, job: jobs, payeeName: users.name, method: paymentMethods.name })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .leftJoin(paymentMethods, eq(paymentMethods.id, invoices.vendorPaidMethodId))
    .where(and(eq(invoices.vendorId, vendorId), isNotNull(invoices.sentAt)))
    .orderBy(desc(invoices.sentAt), desc(invoices.number));
  return rows.map(({ inv, job, payeeName, method }) => ({
    id: inv.id,
    number: formatInvoiceNumber(invoiceNumberPrefix, inv.number),
    kind: inv.kind,
    status: inv.status,
    jobId: job.id,
    jobNumber: job.number,
    jobTitle: job.title,
    jobStartAt: job.startAt,
    payeeName,
    minutes: inv.minutes,
    rateCents: inv.rateCents,
    totalCents: inv.totalCents,
    sentAt: inv.sentAt!,
    deputyPaidAt: inv.deputyPaidAt,
    vendorPaid: inv.vendorPaidAt ? { at: inv.vendorPaidAt, method, reference: inv.vendorPaidReference } : null,
  }));
}
