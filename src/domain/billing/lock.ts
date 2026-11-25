import { and, desc, eq, exists, gt, inArray, isNull, sql, type SQL } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, billingLockOverrides, invoices, jobs, paymentIssues, users } from "@/db/schema";
import type { BillingLockReader } from "@/domain/assignments/signup";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { NotFoundError, ValidationError } from "@/domain/errors";
import { emit } from "@/domain/notifications/notify";
import { getSettings, type AgencySettings } from "@/domain/settings/settings";
import { AGENCY_TZ, agencyDateParts } from "@/domain/time/agency-time";
import { isJobLocked } from "@/domain/vendor-portal/holds";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

type Responsible = "deputy" | "coordinator" | "vendor" | null;
export type LockSettings = Pick<AgencySettings, "unbilledGraceHours" | "billingLockEnabled" | "paymentAckLockMode" | "responseDays">;
export type UnackInput = { sentAt: Date; deputyPaidAt: Date | null; responsibleParty: Responsible; responsibleSince: Date | null; hasOpenIssue: boolean };
export type LockStatus = { locked: boolean; unbilledCount: number; unacknowledgedCount: number };

export function unbilledOverdue(endAt: Date, now: Date, s: Pick<LockSettings, "unbilledGraceHours">): boolean {
  return endAt.getTime() + s.unbilledGraceHours * HOUR_MS <= now.getTime();
}

/**
 * An invoice is overdue for the person's acknowledgment when the vendor reported paying and the person has
 * not confirmed within the deputy response days (`vendor_reported`), or, in `all_invoices` mode, when a sent
 * invoice has had no payment from either side for the vendor plus deputy response days. An open issue clears it.
 */
export function acknowledgmentOverdue(inv: UnackInput, now: Date, s: Pick<LockSettings, "paymentAckLockMode" | "responseDays">): boolean {
  if (s.paymentAckLockMode === "off" || inv.hasOpenIssue || inv.deputyPaidAt) return false;
  if (inv.responsibleParty === "deputy" && inv.responsibleSince && inv.responsibleSince.getTime() + s.responseDays.deputy * DAY_MS <= now.getTime()) return true;
  return s.paymentAckLockMode === "all_invoices" && inv.sentAt.getTime() + (s.responseDays.vendor + s.responseDays.deputy) * DAY_MS <= now.getTime();
}

export function billingLockStatus(input: {
  unbilled: Array<{ endAt: Date }>;
  unacknowledged: UnackInput[];
  now: Date;
  s: LockSettings;
  override: { until: Date } | null;
}): LockStatus {
  const { now, s } = input;
  const unbilledCount = s.billingLockEnabled ? input.unbilled.filter((u) => unbilledOverdue(u.endAt, now, s)).length : 0;
  const unacknowledgedCount = input.unacknowledged.filter((i) => acknowledgmentOverdue(i, now, s)).length;
  const overridden = input.override !== null && input.override.until.getTime() > now.getTime();
  return { locked: !overridden && (unbilledCount > 0 || unacknowledgedCount > 0), unbilledCount, unacknowledgedCount };
}

export type UnbilledItem = { assignmentId: string; jobId: string; jobNumber: number; title: string; endAt: Date };
export type UnackItem = UnackInput & { invoiceId: string; number: number; jobId: string };

/**
 * The person's details waiting to be billed: signed_up on a job that has ended (not canceled, declined or
 * locked by a vendor payment hold), and late cancellations once the detail's scheduled end has passed. A returned invoice
 * puts its assignment back in one of those states, so it shows up here again.
 */
export async function loadUnbilled(tx: Tx, userId: string, now: Date): Promise<UnbilledItem[]> {
  return loadUnbilledWhere(tx, eq(assignments.userId, userId), now);
}

/**
 * `loadUnbilled` for every assignment matching `where` (on assignments), with whose it is. A detail staff wrote off
 * is never waiting to be billed.
 */
export async function loadUnbilledWhere(tx: Tx, where: SQL | undefined, now: Date): Promise<Array<UnbilledItem & { userId: string }>> {
  const rows = await tx
    .select({ a: assignments, job: jobs })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(and(where, inArray(assignments.status, ["signed_up", "late_canceled"]), isNull(assignments.writtenOffAt)));
  const out: Array<UnbilledItem & { userId: string }> = [];
  for (const { a, job } of rows) {
    let endAt: Date;
    // Late-cancel pay counts once the detail's scheduled end has passed, like a worked detail: it cannot be billed before.
    if (a.status === "late_canceled") {
      if (job.endAt.getTime() > now.getTime()) continue;
      endAt = job.endAt;
    } else {
      if (job.state === "canceled" || job.state === "declined" || job.endAt.getTime() > now.getTime()) continue;
      if (await isJobLocked(tx, job.id)) continue;
      endAt = job.endAt;
    }
    out.push({ assignmentId: a.id, jobId: job.id, jobNumber: job.number, title: job.title, endAt, userId: a.userId });
  }
  return out.sort((x, y) => x.endAt.getTime() - y.endAt.getTime() || x.assignmentId.localeCompare(y.assignmentId));
}

/** Sent invoices the person is owed on and has not marked paid. */
export async function loadSentInvoices(tx: Tx, userId: string): Promise<UnackItem[]> {
  const rows = await tx
    .select({
      invoiceId: invoices.id,
      number: invoices.number,
      jobId: assignments.jobId,
      sentAt: invoices.sentAt,
      deputyPaidAt: invoices.deputyPaidAt,
      responsibleParty: invoices.responsibleParty,
      responsibleSince: invoices.responsibleSince,
      hasOpenIssue: exists(tx.select({ x: paymentIssues.id }).from(paymentIssues).where(and(eq(paymentIssues.invoiceId, invoices.id), eq(paymentIssues.status, "open")))),
    })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .where(and(eq(invoices.payeeUserId, userId), eq(invoices.status, "sent")));
  // A sent invoice always has sentAt; a row without it is not counted.
  return rows.flatMap((r) => (r.sentAt ? [{ ...r, sentAt: r.sentAt, hasOpenIssue: Boolean(r.hasOpenIssue) }] : []));
}

/** The newest override that has not expired. */
export async function activeOverride(tx: Tx, userId: string, now: Date) {
  const [row] = await tx
    .select()
    .from(billingLockOverrides)
    .where(and(eq(billingLockOverrides.userId, userId), gt(billingLockOverrides.until, now)))
    .orderBy(desc(billingLockOverrides.createdAt), desc(billingLockOverrides.id))
    .limit(1);
  return row ?? null;
}

export const realBillingLockReader: BillingLockReader = async (tx, userId, now) => {
  const s = await getSettings(tx);
  if (!s.billingLockEnabled && s.paymentAckLockMode === "off") return { locked: false, unbilledCount: 0, unacknowledgedCount: 0 };
  const unbilled = s.billingLockEnabled ? await loadUnbilled(tx, userId, now) : [];
  const unacknowledged = s.paymentAckLockMode === "off" ? [] : await loadSentInvoices(tx, userId);
  const override = await activeOverride(tx, userId, now);
  return billingLockStatus({ unbilled, unacknowledged, now, s, override });
};

/**
 * The same answer as `realBillingLockReader`, for every active personnel, coordinator and admin account at once,
 * in four queries (settings, unbilled assignments with open holds, sent invoices, overrides). Only locked people
 * are returned. Used by the coordinators' to-do list.
 */
export async function lockedPeople(tx: Tx, now: Date): Promise<Array<LockStatus & { userId: string; name: string }>> {
  const s = await getSettings(tx);
  if (!s.billingLockEnabled && s.paymentAckLockMode === "off") return [];
  const people = and(eq(users.active, true), inArray(users.role, ["personnel", "coordinator", "admin"]));
  const unbilled = new Map<string, Array<{ endAt: Date }>>();
  if (s.billingLockEnabled) {
    const rows = await tx
      .select({
        userId: assignments.userId,
        status: assignments.status,
        state: jobs.state,
        endAt: jobs.endAt,
        // Locked by an open vendor hold placed before the job started (see isJobLocked).
        locked: sql<boolean>`exists (select 1 from vendor_holds h where h.vendor_id = ${jobs.vendorId} and h.resolved_at is null and ${jobs.startAt} > h.placed_at)`,
      })
      .from(assignments)
      .innerJoin(jobs, eq(jobs.id, assignments.jobId))
      .innerJoin(users, eq(users.id, assignments.userId))
      .where(and(people, inArray(assignments.status, ["signed_up", "late_canceled"]), isNull(assignments.writtenOffAt)));
    for (const r of rows) {
      let endAt: Date;
      if (r.status === "late_canceled") {
        if (r.endAt.getTime() > now.getTime()) continue;
        endAt = r.endAt;
      } else {
        if (r.state === "canceled" || r.state === "declined" || r.endAt.getTime() > now.getTime()) continue;
        if (r.locked && (r.state === "requested" || r.state === "scheduled" || r.state === "active")) continue;
        endAt = r.endAt;
      }
      unbilled.set(r.userId, [...(unbilled.get(r.userId) ?? []), { endAt }]);
    }
  }
  const unack = new Map<string, UnackInput[]>();
  if (s.paymentAckLockMode !== "off") {
    const rows = await tx
      .select({
        userId: invoices.payeeUserId,
        sentAt: invoices.sentAt,
        deputyPaidAt: invoices.deputyPaidAt,
        responsibleParty: invoices.responsibleParty,
        responsibleSince: invoices.responsibleSince,
        hasOpenIssue: exists(tx.select({ x: paymentIssues.id }).from(paymentIssues).where(and(eq(paymentIssues.invoiceId, invoices.id), eq(paymentIssues.status, "open")))),
      })
      .from(invoices)
      .innerJoin(users, eq(users.id, invoices.payeeUserId))
      .where(and(people, eq(invoices.status, "sent")));
    for (const r of rows) {
      if (!r.sentAt) continue;
      unack.set(r.userId, [...(unack.get(r.userId) ?? []), { ...r, sentAt: r.sentAt, hasOpenIssue: Boolean(r.hasOpenIssue) }]);
    }
  }
  const ids = [...new Set([...unbilled.keys(), ...unack.keys()])];
  if (ids.length === 0) return [];
  const overrides = await tx
    .select({ userId: billingLockOverrides.userId, until: billingLockOverrides.until })
    .from(billingLockOverrides)
    .where(and(inArray(billingLockOverrides.userId, ids), gt(billingLockOverrides.until, now)))
    .orderBy(desc(billingLockOverrides.createdAt), desc(billingLockOverrides.id));
  const override = new Map<string, { until: Date }>();
  for (const o of overrides) if (!override.has(o.userId)) override.set(o.userId, { until: o.until });
  const names = new Map((await tx.select({ id: users.id, name: users.name }).from(users).where(inArray(users.id, ids))).map((u) => [u.id, u.name]));
  const out: Array<LockStatus & { userId: string; name: string }> = [];
  for (const id of ids) {
    const st = billingLockStatus({ unbilled: unbilled.get(id) ?? [], unacknowledged: unack.get(id) ?? [], now, s, override: override.get(id) ?? null });
    if (st.locked) out.push({ ...st, userId: id, name: names.get(id) ?? "" });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const REMINDER_DAYS = { daily: 1, every_other_day: 2, weekly: 7 } as const;

function agencyDayNumber(d: Date): number {
  const p = agencyDateParts(d);
  return Math.round(Date.UTC(p.year, p.month - 1, p.day) / DAY_MS);
}

/**
 * Due when enough agency calendar days have passed since the last reminder (daily: any earlier date, every
 * other day: 2 or more days, weekly: 7 or more). Calendar days, not elapsed hours, so a run a few seconds
 * early still sends.
 */
export function reminderDue(lastSentAt: Date | null, frequency: keyof typeof REMINDER_DAYS, now: Date): boolean {
  return lastSentAt === null || agencyDayNumber(now) - agencyDayNumber(lastSentAt) >= REMINDER_DAYS[frequency];
}

/** A coordinator or admin lifts the person's billing lock until `until`; the person is told. */
export async function overrideBillingLock(
  actor: Actor,
  tx: Tx,
  userId: string,
  input: { reason: string; until: Date },
  now: Date = new Date(),
) {
  assertCan(actor, "billing.overrideLock");
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Give a reason for the override.");
  if (!(input.until instanceof Date) || Number.isNaN(input.until.getTime()) || input.until.getTime() <= now.getTime()) {
    throw new ValidationError("The override must end in the future.");
  }
  const [person] = await tx.select({ id: users.id }).from(users).where(eq(users.id, userId));
  if (!person) throw new NotFoundError("User not found.");
  const [row] = await tx
    .insert(billingLockOverrides)
    .values({ userId, reason, until: input.until, createdBy: actor.userId, createdAt: now })
    .returning();
  await recordAudit(tx, { actor, action: "billing.lock_override", entityType: "billing_lock_override", entityId: row.id, before: null, after: row, reason });
  await emit(tx, {
    recipients: [userId],
    type: "billing.lock_overridden",
    title: "Your sign-up lock was lifted",
    body: `A coordinator lifted your billing lock until ${input.until.toLocaleDateString("en-US", { timeZone: AGENCY_TZ, month: "short", day: "numeric", year: "numeric" })}. Reason: ${reason}`,
    link: "/",
  }, now);
  return row;
}
