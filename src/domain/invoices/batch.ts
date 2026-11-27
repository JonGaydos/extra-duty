import { and, asc, desc, eq, gte, inArray, isNull, ne, or } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import { assignments, invoiceBatches, invoiceEvents, invoices, jobs, users, vendors, w9s } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { applyResponsibility, vendorEvent } from "@/domain/billing/payments";
import { DomainError, NotFoundError, ValidationError } from "@/domain/errors";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";
import { getSettings, type AgencySettings } from "@/domain/settings/settings";
import { agencyDayKey } from "@/domain/time/agency-time";
import { currentW9, readW9ForInvoiceEmail } from "@/domain/w9/w9";
import { queueInvoiceBatchJob } from "@/jobs/boss";
import { settingsProblemMessage } from "@/lib/email/provider";
import { getEmailSender } from "@/lib/email/sender";
import { invoiceBatchEmail } from "@/lib/email/templates/invoice-batch";
import type { OutgoingEmail } from "@/lib/email/types";
import { renderBatchCoverPdf } from "@/lib/pdf/batch-cover-pdf";
import { formatMoney, renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import type { Storage } from "@/lib/storage";
import type { Cents } from "../types";
import { assertInvoiceEmailReady, invoiceSettingsProblem } from "./email";
import { buildInvoicePdfData, formatInvoiceNumber, loadAgencyHeader, type Invoice } from "./invoices";
import { effectiveSchedule, isSendDay, nextSendDay, queuedSendText, type ScheduleAnchors, type SendSchedule } from "./send-schedule";

/**
 * Queued for a batch: ready to send, or a paid invoice explicitly queued to go out as its paid version (it stays paid
 * and closed). A queued date alone never queues a paid invoice, so a closed or unsent row with a stale one is never sent.
 */
const QUEUED = or(eq(invoices.status, "ready_to_send"), and(eq(invoices.status, "paid"), eq(invoices.paidSendQueued, true), isNull(invoices.sentAt)))!;
const isQueued = (i: Pick<Invoice, "status" | "sentAt" | "paidSendQueued">) => i.status === "ready_to_send" || (i.status === "paid" && i.paidSendQueued && i.sentAt === null);
/** Members of a sent batch: the unpaid invoices it sent, and the paid ones that went out as paid versions. */
const IN_SENT_BATCH = or(eq(invoices.status, "sent"), and(eq(invoices.status, "paid"), eq(invoices.paidSendQueued, true)))!;

/** Assignment statuses that still owe a bill: the person is on the detail and has not billed. */
const UNRESOLVED = ["signed_up", "pending_short", "late_canceled"] as const;

type BatchInvoice = {
  id: string;
  number: string;
  jobId: string;
  jobNumber: number;
  jobTitle: string;
  jobStartAt: Date;
  payeeUserId: string;
  payeeName: string;
  totalCents: Cents;
  attachW9: boolean;
  hasW9: boolean;
  /** Its detail is held until every assigned deputy has billed. */
  waiting: boolean;
  /** Already paid: it goes out as its paid version and adds nothing to the total due. */
  paid: boolean;
};

/** A held detail: `names` have not billed yet; `inReview` billed but their invoice still waits for review. */
export type WaitingDetail = { jobId: string; jobNumber: number; jobTitle: string; names: string[]; inReview: string[] };

/** "Waiting on 1 deputy to bill (Jordan Lee) and 1 invoice in review (Sam Ortiz)" */
export function waitingText(w: Pick<WaitingDetail, "names" | "inReview">): string {
  const part = (list: string[], one: string, many: string) => `${list.length} ${list.length === 1 ? one : many} (${list.join(", ")})`;
  const parts = [
    ...(w.names.length ? [part(w.names, "deputy to bill", "deputies to bill")] : []),
    ...(w.inReview.length ? [part(w.inReview, "invoice in review", "invoices in review")] : []),
  ];
  return `Waiting on ${parts.join(" and ")}`;
}

export type VendorBatch = {
  vendorId: string;
  vendorName: string;
  schedule: SendSchedule;
  /** The scheduled send day (agency date key) for the oldest invoice in the batch. */
  sendDay: string;
  /** True from the send day on. */
  due: boolean;
  invoices: BatchInvoice[];
  waiting: WaitingDetail[];
  /** Payees without a current W-9 (each could have one attached in this batch). */
  missingW9: Array<{ userId: string; name: string }>;
  /** Total due of the invoices that would go now (not waiting, not already paid). */
  totalCents: Cents;
  /** Why the last batch email to this vendor failed, when its invoices came back to the queue; else null. */
  lastSendFailed: string | null;
};

export type SendBatchInput = {
  /** Attach the current W-9 of every payee in the batch, whatever each person chose. */
  attachW9ForAll: boolean;
  /** Invoices whose W-9 should go but whose payee has none: send without it, or hold them for a later batch. */
  missingW9: "send" | "hold";
  /** Also send the invoices of details still waiting on deputies (needs a reason). */
  includeWaiting: boolean;
  /** Required when sending before the send day or while deputies are still waiting. */
  reason?: string;
};

export type SendBatchResult = { batchId: string; sent: number; held: number };

/** The date a queued invoice is scheduled to go: the schedule's next send day on or after both its queued date and today. */
function queuedSendDay(schedule: SendSchedule, s: ScheduleAnchors, readyAt: Date, now: Date): string {
  const ready = agencyDayKey(readyAt);
  const today = agencyDayKey(now);
  // Once the scheduled day has passed unsent, name the next real send day.
  return nextSendDay(schedule, s, ready > today ? ready : today);
}

/** The batched send a ready invoice waits for: its schedule and send day; null for any other or an immediate schedule. */
export function queuedSendOf(
  inv: { status: Invoice["status"]; readyAt: Date | null; sentAt: Date | null; paidSendQueued: boolean },
  vendorSchedule: SendSchedule | null,
  s: ScheduleAnchors & { invoiceSendSchedule: SendSchedule },
  now: Date,
): { schedule: Exclude<SendSchedule, "immediate">; day: string } | null {
  if (!inv.readyAt || !isQueued(inv)) return null;
  const schedule = effectiveSchedule(vendorSchedule, s);
  if (schedule === "immediate") return null;
  return { schedule, day: queuedSendDay(schedule, s, inv.readyAt, now) };
}

/** "Queued for the weekly send on Fri, Nov 27." for a ready invoice; null for any other or an immediate schedule. */
export function queuedSendFor(
  inv: { status: Invoice["status"]; readyAt: Date | null; sentAt: Date | null; paidSendQueued: boolean },
  vendorSchedule: SendSchedule | null,
  s: AgencySettings,
  now: Date,
): string | null {
  const q = queuedSendOf(inv, vendorSchedule, s, now);
  return q ? queuedSendText(q.schedule, q.day) : null;
}

/** True when an approved invoice for this vendor waits for a batch instead of going at once. */
export async function isBatched(tx: Tx, vendorId: string, s: AgencySettings): Promise<boolean> {
  const [v] = await tx.select({ schedule: vendors.invoiceSendSchedule }).from(vendors).where(eq(vendors.id, vendorId));
  return effectiveSchedule(v?.schedule ?? null, s) !== "immediate";
}

/**
 * Moves an approved invoice into the batch queue: status ready_to_send, no sent date and no email yet. Nobody's
 * response clock runs while it waits; the vendor's starts when the batch is sent. The caller audits.
 */
export async function queueForBatch(tx: Tx, invoiceId: string, now: Date, actor: Actor): Promise<void> {
  await tx.update(invoices).set({ status: "ready_to_send", readyAt: now, sentAt: null, emailStatus: "not_queued" }).where(eq(invoices.id, invoiceId));
  await applyResponsibility(tx, invoiceId, now, actor);
  await tx.insert(invoiceEvents).values({ invoiceId, actorUserId: actor.userId, event: "ready_to_send", vendorVisible: false, at: now });
}

/**
 * Queues a paid invoice (paid on the spot, already closed) to go out marked paid with the vendor's next send. It stays
 * paid: the queued date and paidSendQueued mark it, and it adds nothing to the total due. The caller audits.
 */
export async function queuePaidSend(tx: Tx, invoiceId: string, now: Date, actor: Actor): Promise<void> {
  await tx.update(invoices).set({ readyAt: now, sentAt: null, emailStatus: "not_queued", paidSendQueued: true }).where(eq(invoices.id, invoiceId));
  await tx.insert(invoiceEvents).values({ invoiceId, actorUserId: actor.userId, event: "ready_to_send", vendorVisible: false, at: now });
}

function queuedRows(tx: Tx, vendorId?: string) {
  const conds = [QUEUED];
  if (vendorId) conds.push(eq(invoices.vendorId, vendorId));
  return tx
    .select({ inv: invoices, job: jobs, payeeName: users.name, vendorName: vendors.name, vendorSchedule: vendors.invoiceSendSchedule })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(and(...conds))
    .orderBy(asc(vendors.name), asc(vendors.id), asc(jobs.startAt), asc(invoices.number));
}
type QueuedRow = Awaited<ReturnType<typeof queuedRows>>[number];

function namesByJob(rows: Array<{ jobId: string; name: string }>): Map<string, string[]> {
  const byJob = new Map<string, string[]>();
  for (const r of rows) byJob.set(r.jobId, [...(byJob.get(r.jobId) ?? []), r.name]);
  return byJob;
}

/**
 * On the details that wait for all deputies: per detail, who has not billed yet, and whose invoice is still in
 * review (a detail's invoices go together, so one still in review holds the rest).
 */
async function holdingNames(tx: Tx, waitJobIds: string[]): Promise<{ waitingNames: Map<string, string[]>; reviewNames: Map<string, string[]> }> {
  if (waitJobIds.length === 0) return { waitingNames: new Map(), reviewNames: new Map() };
  const open = await tx
    .select({ jobId: assignments.jobId, name: users.name })
    .from(assignments)
    .innerJoin(users, eq(users.id, assignments.userId))
    .where(and(inArray(assignments.jobId, waitJobIds), inArray(assignments.status, [...UNRESOLVED])))
    .orderBy(asc(users.name));
  const reviewing = await tx
    .select({ jobId: assignments.jobId, name: users.name })
    .from(invoices)
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .where(and(inArray(assignments.jobId, waitJobIds), eq(invoices.status, "pending_review")))
    .orderBy(asc(users.name));
  return { waitingNames: namesByJob(open), reviewNames: namesByJob(reviewing) };
}

/** Adds one queued invoice to its vendor's batch: the list, the total due, the waiting details, missing W-9s and the send day. */
function addToBatch(
  b: VendorBatch,
  row: QueuedRow,
  held: { names: string[]; inReview: string[] },
  hasW9: boolean,
  s: AgencySettings,
): void {
  const { inv, job, payeeName } = row;
  const { names, inReview } = held;
  const waiting = names.length > 0 || inReview.length > 0;
  b.invoices.push({
    id: inv.id,
    number: formatInvoiceNumber(s.invoiceNumberPrefix, inv.number),
    jobId: job.id,
    jobNumber: job.number,
    jobTitle: job.title,
    jobStartAt: job.startAt,
    payeeUserId: inv.payeeUserId,
    payeeName,
    totalCents: inv.totalCents,
    attachW9: inv.attachW9,
    hasW9,
    waiting,
    paid: inv.status === "paid",
  });
  if (!waiting && inv.status !== "paid") b.totalCents += inv.totalCents;
  if (waiting && !b.waiting.some((w) => w.jobId === job.id)) b.waiting.push({ jobId: job.id, jobNumber: job.number, jobTitle: job.title, names, inReview });
  if (!hasW9 && !b.missingW9.some((m) => m.userId === inv.payeeUserId)) b.missingW9.push({ userId: inv.payeeUserId, name: payeeName });
  const readyKey = agencyDayKey(inv.readyAt ?? inv.updatedAt);
  const day = nextSendDay(b.schedule, s, readyKey);
  if (!b.sendDay || day < b.sendDay) b.sendDay = day;
}

/**
 * A failed batch email puts its invoices back here. An invoice shows the failure while it is the newest of its
 * queue events (written order, so a later re-queue after a re-bill clears it).
 */
async function markLastSendFailures(tx: Tx, rows: QueuedRow[], out: Map<string, VendorBatch>): Promise<void> {
  const queueEvents = await tx
    .select({ invoiceId: invoiceEvents.invoiceId, event: invoiceEvents.event, note: invoiceEvents.note })
    .from(invoiceEvents)
    .where(and(inArray(invoiceEvents.invoiceId, rows.map((r) => r.inv.id)), inArray(invoiceEvents.event, ["send_failed", "ready_to_send"])))
    .orderBy(desc(invoiceEvents.createdAt), desc(invoiceEvents.id));
  const seen = new Set<string>();
  for (const e of queueEvents) {
    if (seen.has(e.invoiceId)) continue;
    seen.add(e.invoiceId);
    if (e.event !== "send_failed") continue;
    const b = out.get(rows.find((x) => x.inv.id === e.invoiceId)!.inv.vendorId)!;
    b.lastSendFailed ??= e.note ?? "The last send failed.";
  }
}

/**
 * Every vendor's queued invoices as batches, in a fixed number of queries. A detail whose wait-for-all-deputies
 * applies (its own setting, else the agency's) holds its invoices while anyone on it has not billed.
 */
async function loadBatches(tx: Tx, s: AgencySettings, now: Date, vendorId?: string): Promise<VendorBatch[]> {
  const rows = await queuedRows(tx, vendorId);
  if (rows.length === 0) return [];

  const waitJobIds = [...new Set(rows.filter((r) => r.job.waitForAllDeputies ?? s.waitForAllDeputies).map((r) => r.job.id))];
  const { waitingNames, reviewNames } = await holdingNames(tx, waitJobIds);

  const payeeIds = [...new Set(rows.map((r) => r.inv.payeeUserId))];
  const withW9 = new Set(
    (await tx.select({ userId: w9s.userId }).from(w9s).where(and(inArray(w9s.userId, payeeIds), eq(w9s.current, true)))).map((w) => w.userId),
  );

  const today = agencyDayKey(now);
  const out = new Map<string, VendorBatch>();
  for (const row of rows) {
    const { inv, job, vendorName, vendorSchedule } = row;
    let b = out.get(inv.vendorId);
    if (!b) {
      const schedule = effectiveSchedule(vendorSchedule, s);
      // Rows are per vendor, oldest job first; the oldest queued date decides the send day below.
      b = { vendorId: inv.vendorId, vendorName, schedule, sendDay: "", due: false, invoices: [], waiting: [], missingW9: [], totalCents: 0, lastSendFailed: null };
      out.set(inv.vendorId, b);
    }
    const held = { names: waitingNames.get(job.id) ?? [], inReview: reviewNames.get(job.id) ?? [] };
    addToBatch(b, row, held, withW9.has(inv.payeeUserId), s);
  }
  for (const b of out.values()) b.due = b.sendDay <= today;

  await markLastSendFailures(tx, rows, out);
  return [...out.values()];
}

/** Every vendor with invoices ready to send, for the Send invoices screen. */
export async function listInvoiceBatches(actor: Actor, tx: Tx, now: Date = new Date()): Promise<VendorBatch[]> {
  assertCan(actor, "invoice.review");
  return loadBatches(tx, await getSettings(tx), now);
}

/**
 * Which vendors are on a batched send: the agency's own schedule, and each active vendor whose own schedule batches
 * (vendors following a batched agency schedule are counted, not listed). For the empty Send invoices page.
 */
export async function batchedVendors(actor: Actor, tx: Tx): Promise<{ agency: SendSchedule; following: number; vendors: Array<{ id: string; name: string; schedule: SendSchedule }> }> {
  assertCan(actor, "invoice.review");
  const s = await getSettings(tx);
  const rows = await tx.select({ id: vendors.id, name: vendors.name, schedule: vendors.invoiceSendSchedule }).from(vendors).where(eq(vendors.active, true)).orderBy(asc(vendors.name));
  const own = rows.filter((v): v is { id: string; name: string; schedule: SendSchedule } => v.schedule !== null && v.schedule !== "immediate");
  const following = s.invoiceSendSchedule === "immediate" ? 0 : rows.filter((v) => v.schedule === null).length;
  return { agency: s.invoiceSendSchedule, following, vendors: own };
}

/** Batches due today or earlier, for the coordinator to-do. The caller authorizes. */
export async function dueInvoiceBatches(tx: Tx, s: AgencySettings, now: Date): Promise<VendorBatch[]> {
  return (await loadBatches(tx, s, now)).filter((b) => b.due);
}

/**
 * Sends one vendor's batch: every included invoice becomes sent at `now` (the vendor's response clock starts),
 * and one email goes to the vendor with a cover summary, each invoice PDF and the W-9s asked for. Sending before
 * the send day, or with details still waiting on deputies, needs a reason; it is kept on the batch and audited.
 */
export async function sendInvoiceBatch(actor: Actor, tx: Tx, vendorId: string, input: SendBatchInput, now: Date = new Date()): Promise<SendBatchResult> {
  assertCan(actor, "invoice.review");
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, vendorId)).for("update");
  if (!vendor) throw new NotFoundError("Vendor not found.");
  const s = await getSettings(tx);
  const [batch] = await loadBatches(tx, s, now, vendorId);
  if (!batch) throw new ValidationError(`There are no invoices ready to send to ${vendor.name}.`);

  const eligible = batch.invoices.filter((i) => input.includeWaiting || !i.waiting);
  if (eligible.length === 0) throw new ValidationError("Every invoice in this batch is waiting on its detail. Send them early with a reason, or wait.");
  const early = !batch.due || eligible.some((i) => i.waiting);
  const reason = input.reason?.trim() || null;
  if (early && !reason) throw new ValidationError("Give a reason for sending early.");
  const wantsW9 = (i: BatchInvoice) => i.attachW9 || input.attachW9ForAll;
  const chosen = eligible.filter((i) => !(input.missingW9 === "hold" && wantsW9(i) && !i.hasW9));
  if (chosen.length === 0) throw new ValidationError("Nothing to send: every invoice left is held for a missing W-9.");
  // The list above was read without row locks. Lock the rows and keep only those still queued, so a send back or
  // edit that committed in between is never overwritten.
  const locked = await tx
    .select()
    .from(invoices)
    .where(inArray(invoices.id, chosen.map((i) => i.id)))
    .orderBy(asc(invoices.id))
    .for("update");
  const current = new Map(locked.filter((l) => isQueued(l)).map((l) => [l.id, l]));
  const included = chosen.filter((i) => current.has(i.id));
  if (included.length === 0) throw new ValidationError("These invoices changed while you were sending. Reload Send invoices and try again.");
  await assertInvoiceEmailReady(tx, { vendorName: vendor.name, billingEmails: vendor.billingEmails });

  const [row] = await tx
    .insert(invoiceBatches)
    .values({ vendorId, sentBy: actor.userId, sentAt: now, earlyReason: early ? reason : null, attachW9ForAll: input.attachW9ForAll, emailStatus: "queued" })
    .returning();
  // Sequential: updates, events and audit rows for each invoice are written in order in this transaction.
  for (const i of included) {
    const before = current.get(i.id)!;
    // A coordinator's "attach for all" adds the W-9 only where one is on file; a missing one is sent without.
    const addW9 = input.attachW9ForAll && !before.attachW9 && i.hasW9;
    const [after] = await tx
      .update(invoices)
      .set({
        // A paid invoice goes out still paid and closed.
        status: before.status === "paid" ? "paid" : "sent",
        sentAt: now,
        batchId: row.id,
        emailStatus: "queued",
        attachW9: before.attachW9 || addW9,
        w9RequestedBy: addW9 ? actor.userId : before.w9RequestedBy,
      })
      .where(and(eq(invoices.id, i.id), QUEUED))
      .returning();
    await applyResponsibility(tx, i.id, now, actor);
    await tx.insert(invoiceEvents).values({ invoiceId: i.id, actorUserId: actor.userId, event: "sent", vendorVisible: vendorEvent("sent"), at: now });
    await recordAudit(tx, {
      actor,
      action: "invoice.batch_send",
      entityType: "invoice",
      entityId: i.id,
      before: { status: before.status, sentAt: before.sentAt, attachW9: before.attachW9 },
      after: { status: after.status, sentAt: after.sentAt, attachW9: after.attachW9, batchId: row.id },
      reason: reason ?? undefined,
    });
  }
  const held = batch.invoices.filter((i) => !included.includes(i));
  await recordAudit(tx, {
    actor,
    action: "invoice_batch.send",
    entityType: "invoice_batch",
    entityId: row.id,
    after: {
      vendorId,
      invoiceIds: included.map((i) => i.id),
      heldInvoiceIds: held.map((i) => i.id),
      early,
      beforeSendDay: !batch.due,
      sendDay: batch.sendDay,
      attachW9ForAll: input.attachW9ForAll,
      missingW9: input.missingW9,
      missingW9Payees: batch.missingW9.map((m) => m.name),
    },
    reason: reason ?? undefined,
  });
  await queueInvoiceBatchJob(tx, row.id);
  return { batchId: row.id, sent: included.length, held: held.length };
}

/** A detail's own wait-for-all-deputies choice; null goes back to the agency setting. Audited. */
export async function setWaitForAllDeputies(actor: Actor, tx: Tx, jobId: string, value: boolean | null): Promise<void> {
  assertCan(actor, "job.update");
  const [job] = await tx.select({ id: jobs.id, wait: jobs.waitForAllDeputies }).from(jobs).where(eq(jobs.id, jobId)).for("update");
  if (!job) throw new NotFoundError("Detail not found.");
  if (job.wait === value) return;
  await tx.update(jobs).set({ waitForAllDeputies: value }).where(eq(jobs.id, jobId));
  await recordAudit(tx, { actor, action: "job.wait_for_all_deputies", entityType: "job", entityId: jobId, before: { waitForAllDeputies: job.wait }, after: { waitForAllDeputies: value } });
}

const PURPOSE = "sending invoices";

/** Builds the batch email at send time: cover summary, every invoice PDF and each W-9 asked for (reads audited as the sender). */
async function buildBatchMessage(tx: Tx, batchId: string, storage?: Storage): Promise<OutgoingEmail | null> {
  const [batch] = await tx.select().from(invoiceBatches).where(eq(invoiceBatches.id, batchId));
  if (!batch) throw new NotFoundError("Invoice batch not found.");
  const settings = await getSettings(tx);
  const problem = invoiceSettingsProblem(settings.email, settings.billingReplyToEmail);
  if (problem) throw new ValidationError(settingsProblemMessage(problem, PURPOSE));
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, batch.vendorId));
  if (!vendor.billingEmails.length) throw new ValidationError(`Add a billing email to ${vendor.name} before sending invoices.`);
  // An invoice sent back after the batch went out is left out of the email.
  const members = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.batchId, batchId), ne(invoices.status, "returned")))
    .orderBy(asc(invoices.number));
  if (members.length === 0) return null;

  const attachments: NonNullable<OutgoingEmail["attachments"]> = [];
  const rows = [];
  const w9Names: string[] = [];
  // Sequential: the reads share one transaction, and each W-9 read writes its own audit row.
  for (const inv of members) {
    const data = await buildInvoicePdfData(tx, inv.id, storage);
    attachments.push({ filename: `${data.number}.pdf`, content: await renderInvoicePdf(data), contentType: "application/pdf" });
    rows.push({ number: data.number, jobNumber: data.job.number, jobTitle: data.job.title, jobStartAt: data.job.startAt, payeeName: data.payee.name, totalCents: data.totalCents, paid: inv.status === "paid" });
    if (inv.attachW9 && (await currentW9(tx, inv.payeeUserId))) {
      const w9 = await readW9ForInvoiceEmail(tx, inv.id, storage, inv.w9RequestedBy ?? batch.sentBy);
      attachments.push({ filename: `W-9 ${data.payee.name}.pdf`, content: w9.body, contentType: "application/pdf" });
      w9Names.push(data.payee.name);
    }
  }
  const agency = await loadAgencyHeader(tx, storage);
  const replyTo = settings.billingReplyToEmail;
  const cover = await renderBatchCoverPdf({ agency, vendorName: vendor.name, sentAt: batch.sentAt, replyTo, rows });
  const day = agencyDayKey(batch.sentAt);
  attachments.unshift({ filename: `Invoice summary ${vendor.name} ${day}.pdf`, content: cover, contentType: "application/pdf" });
  // A paid invoice is listed but owes nothing: the total due counts only the unpaid ones.
  const total = rows.reduce((sum, r) => sum + (r.paid ? 0 : r.totalCents), 0);
  const paidCount = rows.filter((r) => r.paid).length;
  return {
    ...invoiceBatchEmail({ to: vendor.billingEmails, replyTo, agencyName: agency.name, vendorName: vendor.name, count: rows.length, total: formatMoney(total), paidCount, w9Names }),
    attachments,
  };
}

const DELIMITER = /[\s,;<>"']/;

/**
 * The first `limit` characters of a message, cut back to the last delimiter so no token or address is split (a
 * split piece could slip past the redaction patterns). With no delimiter in reach, the whole start reads as redacted.
 */
function readStart(message: string, limit: number): string {
  if (message.length <= limit || DELIMITER.test(message[limit])) return message.slice(0, limit);
  for (let i = limit - 1; i >= 0; i--) if (DELIMITER.test(message[i])) return message.slice(0, i);
  return "[redacted]";
}

/**
 * A provider error safe to show staff: email addresses, key or token values and long secret-looking strings are
 * replaced, and it is kept short. Only the start of a very long message is read, so the patterns stay fast.
 */
export function redactProviderError(message: string): string {
  const out = readStart(message, 2000)
    .replace(/[^\s<>"'@,;]+@[^\s<>"'@,;]+\.[^\s<>"'@,;]+/g, "[email]")
    // An Authorization value is dropped whole (scheme and credential), up to the end of its clause.
    .replace(/\b(authorization)(\s*[=:]\s*)[^\r\n,;]*/gi, "$1$2[redacted]")
    .replace(/\b(Bearer|Basic|Token)\s+[^\s,;]+/gi, "$1 [redacted]")
    .replace(/\b(api[_-]?key|access[_-]?key|token|password|passwd|secret|auth)(\s*[=:]\s*)(?!\[redacted\])\S+/gi, "$1$2[redacted]")
    .replace(/[A-Za-z0-9_+/=-]{24,}/g, "[redacted]")
    .trim();
  return out.length > 300 ? `${out.slice(0, 297)}...` : out || "The email provider gave no reason.";
}

/** After the email went out: the batch and its invoices are marked sent. */
async function markBatchSent(batchId: string): Promise<void> {
  await withTx(async (tx) => {
    const [batch] = await tx.select().from(invoiceBatches).where(eq(invoiceBatches.id, batchId));
    if (!batch || batch.emailStatus === "sent") return;
    await tx.update(invoiceBatches).set({ emailStatus: "sent" }).where(eq(invoiceBatches.id, batchId));
    const members = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.batchId, batchId), IN_SENT_BATCH));
    if (members.length) await tx.update(invoices).set({ emailStatus: "sent", paidSendQueued: false }).where(inArray(invoices.id, members.map((m) => m.id)));
    await recordAudit(tx, {
      actor: "system",
      action: "invoice_batch.email_sent",
      entityType: "invoice_batch",
      entityId: batchId,
      before: { emailStatus: batch.emailStatus },
      after: { emailStatus: "sent", invoiceIds: members.map((m) => m.id) },
    });
  });
}

/** Every invoice was sent back before the email was built: nothing went out, so nothing is marked sent. */
async function markBatchSkipped(batchId: string): Promise<void> {
  await withTx(async (tx) => {
    const [batch] = await tx.select().from(invoiceBatches).where(eq(invoiceBatches.id, batchId));
    if (batch?.emailStatus !== "queued") return;
    await tx.update(invoiceBatches).set({ emailStatus: "not_queued" }).where(eq(invoiceBatches.id, batchId));
    await recordAudit(tx, {
      actor: "system",
      action: "invoice_batch.email_skipped",
      entityType: "invoice_batch",
      entityId: batchId,
      before: { emailStatus: batch.emailStatus },
      after: { emailStatus: "not_queued", reason: "Every invoice in the batch was sent back before it was emailed." },
    });
  });
}

/**
 * The email never reached the vendor: the batch is marked failed and its invoices go back to the queue (status
 * ready_to_send, no sent date, no batch, nobody's clock running), each with a staff-only `send_failed` event that
 * Send invoices shows. Payees and coordinators are alerted with a link to the vendor's batch.
 */
async function markBatchFailed(batchId: string, reason: string, summary: string): Promise<void> {
  const now = new Date();
  await withTx(async (tx) => {
    const [batch] = await tx.select().from(invoiceBatches).where(eq(invoiceBatches.id, batchId)).for("update");
    if (!batch || batch.emailStatus === "failed" || batch.emailStatus === "sent") return;
    await tx.update(invoiceBatches).set({ emailStatus: "failed" }).where(eq(invoiceBatches.id, batchId));
    const members = await tx
      .select()
      .from(invoices)
      .where(and(eq(invoices.batchId, batchId), IN_SENT_BATCH))
      .orderBy(asc(invoices.id))
      .for("update");
    const note = redactProviderError(reason);
    // A payment the vendor or deputy recorded during the retry window shows the invoice reached the vendor: it stays
    // sent with its clock, and staff are told on its timeline.
    // Judged by when the payment was recorded (the event row's creation, after the batch row was created), never by
    // the paid dates people type, and never by a payment made on the spot before the batch existed.
    const paidSince = members.length
      ? await tx
          .select({ invoiceId: invoiceEvents.invoiceId })
          .from(invoiceEvents)
          .where(
            and(
              inArray(invoiceEvents.invoiceId, members.map((m) => m.id)),
              inArray(invoiceEvents.event, ["vendor_paid", "deputy_paid"]),
              gte(invoiceEvents.createdAt, batch.createdAt),
            ),
          )
      : [];
    const paidIds = new Set(paidSince.map((e) => e.invoiceId));
    // A paid invoice that went out as its paid version is simply queued again, still paid. (One that went out unpaid
    // and was settled during the retry window is not a member here: it stays as it is, as before.)
    const reached = members.filter((m) => m.status !== "paid" && paidIds.has(m.id));
    // Sequential: writes in this transaction.
    for (const inv of reached) {
      await tx.update(invoices).set({ emailStatus: "failed" }).where(eq(invoices.id, inv.id));
      await tx.insert(invoiceEvents).values({
        invoiceId: inv.id,
        event: "send_failed_kept",
        note: `The batch email failed (${note}), but a payment was already recorded, so the invoice stays sent.`,
        vendorVisible: false,
        at: now,
      });
    }
    const requeued = members.filter((m) => !reached.includes(m));
    // Sequential: writes in this transaction.
    for (const inv of requeued) {
      const back = inv.status === "paid" ? "paid" : "ready_to_send";
      await tx.update(invoices).set({ status: back, sentAt: null, batchId: null, emailStatus: "not_queued" }).where(eq(invoices.id, inv.id));
      // The send never reached the vendor: its events leave the vendor's view (staff keep them, marked superseded).
      await tx
        .update(invoiceEvents)
        .set({ vendorVisible: false })
        .where(and(eq(invoiceEvents.invoiceId, inv.id), inArray(invoiceEvents.event, ["sent", "responsibility"]), gte(invoiceEvents.at, batch.sentAt)));
      await tx
        .update(invoiceEvents)
        .set({ note: "Not delivered: the batch email failed." })
        .where(and(eq(invoiceEvents.invoiceId, inv.id), eq(invoiceEvents.event, "sent"), gte(invoiceEvents.at, batch.sentAt)));
      await applyResponsibility(tx, inv.id, now, "system");
      await tx.insert(invoiceEvents).values({ invoiceId: inv.id, event: "send_failed", note, vendorVisible: false, at: now });
      await recordAudit(tx, {
        actor: "system",
        action: "invoice.batch_requeue",
        entityType: "invoice",
        entityId: inv.id,
        before: { status: inv.status, sentAt: inv.sentAt, batchId },
        after: { status: back, sentAt: null, batchId: null },
      });
    }
    await recordAudit(tx, {
      actor: "system",
      action: "invoice_batch.email_failed",
      entityType: "invoice_batch",
      entityId: batchId,
      before: { emailStatus: batch.emailStatus },
      after: { emailStatus: "failed", reason, requeuedInvoiceIds: requeued.map((m) => m.id), keptSentInvoiceIds: reached.map((m) => m.id) },
    });
    const [v] = await tx.select({ name: vendors.name }).from(vendors).where(eq(vendors.id, batch.vendorId));
    await emit(tx, {
      recipients: [...new Set([...members.map((m) => m.payeeUserId), ...(await coordinatorAudience(tx))])],
      type: "invoice.email_failed",
      title: `Invoices for ${v?.name ?? "the vendor"} could not be emailed`,
      body: requeued.length ? `${summary} They are back on Send invoices to send again.` : `${summary} A payment was already recorded on each, so they stay sent.`,
      link: `/coordinate/send-invoices#vendor-${batch.vendorId}`,
    });
  });
}

const SUMMARY_DELIVERY = "The email provider did not accept the invoices after repeated attempts. Check the email settings, then send them again.";

/**
 * Worker side of a batch email job, like deliverInvoiceEmail: a transient failure rethrows for a retry until the
 * final attempt; a DomainError fails at once. Once sent, the batch and its invoices are marked sent.
 */
export async function deliverInvoiceBatchEmail(batchId: string, o: { finalAttempt: boolean; storage?: Storage }): Promise<void> {
  try {
    const skip = await withTx(async (tx) => {
      const [b] = await tx.select({ s: invoiceBatches.emailStatus }).from(invoiceBatches).where(eq(invoiceBatches.id, batchId));
      // Only a queued batch is sent: a sent, failed (requeued) or skipped one is finished.
      return b?.s !== "queued";
    });
    if (skip) return;
    const msg = await withTx((tx) => buildBatchMessage(tx, batchId, o.storage));
    if (!msg) {
      await markBatchSkipped(batchId);
      return;
    }
    await getEmailSender().send(msg);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof DomainError) {
      await markBatchFailed(batchId, reason, `The invoices could not be emailed. ${reason}`);
      return;
    }
    if (o.finalAttempt) await markBatchFailed(batchId, reason, SUMMARY_DELIVERY);
    throw err;
  }
  // Sequential: each attempt runs only after the previous one failed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await markBatchSent(batchId);
      return;
    } catch (err) {
      console.error(`Invoice batch ${batchId} was emailed but marking it sent failed (attempt ${attempt}):`, err);
    }
  }
}

/**
 * Daily tick. On a vendor's send day, when its batch is due, coordinators get one "Send invoices" alert listing
 * the vendors. Returns the number of vendor batches in the alert.
 */
export async function invoiceBatchesDueTick(now: Date): Promise<number> {
  return withTx(async (tx) => {
    const s = await getSettings(tx);
    const today = agencyDayKey(now);
    const due = (await dueInvoiceBatches(tx, s, now)).filter((b) => isSendDay(b.schedule, s, today));
    if (due.length === 0) return 0;
    const names = due.map((b) => b.vendorName).join(", ");
    await emit(
      tx,
      {
        recipients: await coordinatorAudience(tx),
        type: "invoice.batch_due",
        title: "Invoices are ready to send",
        body: `${due.length} vendor ${due.length === 1 ? "batch is" : "batches are"} ready to review and send: ${names}.`,
        link: "/coordinate/send-invoices",
      },
      now,
    );
    return due.length;
  });
}
