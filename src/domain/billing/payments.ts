import { and, asc, desc, eq, isNotNull } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoiceEvents, invoices, paymentIssues, paymentMethods } from "@/db/schema";
import { emit } from "@/domain/notifications/notify";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { formatInvoiceNumber, type Invoice } from "@/domain/invoices/invoices";
import { getSettings } from "@/domain/settings/settings";

export type Party = "deputy" | "coordinator" | "vendor";
type InvoiceEvent = typeof invoiceEvents.$inferSelect;
/** Staff and payees get full rows; vendors get no user ids, `vendorVisible` or audit columns. */
export type TimelineEvent = Pick<InvoiceEvent, "id" | "invoiceId" | "event" | "party" | "note" | "at"> & {
  actorUserId?: string | null;
  vendorVisible?: boolean;
};

export type PaymentInput = { paymentMethodId: string; reference: string; paidAt: Date; note?: string };
export type CloseInput = { outcome: "paid" | "written_off"; reason: string };

type ResponsibilityInvoice = Pick<Invoice, "status" | "deputyPaidAt" | "vendorPaidAt">;

/** Events a vendor may see. Anything else (edits, send backs, re-bills, future events) stays staff and payee only. */
const VENDOR_EVENTS = new Set(["sent", "revised", "responsibility", "vendor_paid", "deputy_paid", "closed_paid", "closed_written_off", "issue_waiting_on"]);
/** Of those, the events whose note is the payee's or vendor's own and so may be shown to the vendor. */
/** Writers set `vendorVisible` from this so they cannot disagree with the allowlist. */
export const vendorEvent = (name: string): boolean => VENDOR_EVENTS.has(name);
const VENDOR_NOTE_EVENTS = new Set(["vendor_paid", "deputy_paid"]);

const DAY_MS = 86_400_000;

function violation(check: string, message: string): RuleViolation {
  return new RuleViolation([{ check: `payment.${check}`, ok: false, message }], message);
}

/** Spec 12.10. An open issue with no `waitingOn` belongs to the coordinator. */
export function paymentResponsibility(
  inv: ResponsibilityInvoice,
  openIssue: { waitingOn: Party | null } | null,
): Party | null {
  // A queued or unsent invoice is no one's turn: the vendor's clock starts when it is sent.
  if (inv.status === "paid" || inv.status === "written_off" || inv.status === "ready_to_send" || inv.status === "approved_unsent") return null;
  if (inv.status === "pending_review") return "coordinator";
  if (inv.status === "returned") return "deputy";
  if (openIssue) return openIssue.waitingOn ?? "coordinator";
  if (inv.vendorPaidAt && !inv.deputyPaidAt) return "deputy";
  return "vendor";
}

export function responsibleDueAt(party: Party, since: Date, s: { responseDays: Record<Party, number> }): Date {
  return new Date(since.getTime() + s.responseDays[party] * DAY_MS);
}

export function isOverdue(
  inv: { responsibleParty: Party | null; responsibleSince: Date | null },
  now: Date,
  s: { responseDays: Record<Party, number> },
): boolean {
  if (!inv.responsibleParty || !inv.responsibleSince) return false;
  return now.getTime() > responsibleDueAt(inv.responsibleParty, inv.responsibleSince, s).getTime();
}

/**
 * Recomputes who is responsible for the invoice. When the party changes it sets `responsibleParty` and
 * `responsibleSince = now` and writes one timeline event; when it does not change, nothing is touched.
 * Every service that changes an invoice or its issue calls this after the change.
 */
export async function applyResponsibility(
  tx: Tx,
  invoiceId: string,
  now: Date = new Date(),
  actor: Actor | "system" = "system",
): Promise<Party | null> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new NotFoundError("Invoice not found.");
  const [issue] = await tx
    .select({ waitingOn: paymentIssues.waitingOn })
    .from(paymentIssues)
    .where(and(eq(paymentIssues.invoiceId, invoiceId), eq(paymentIssues.status, "open")))
    .orderBy(desc(paymentIssues.createdAt))
    .limit(1);
  const party = paymentResponsibility(inv, issue ?? null);
  if (party === inv.responsibleParty) return party;
  await tx.update(invoices).set({ responsibleParty: party, responsibleSince: party ? now : null }).where(eq(invoices.id, invoiceId));
  await tx.insert(invoiceEvents).values({
    invoiceId,
    actorUserId: actor === "system" ? null : actor.userId,
    event: "responsibility",
    party,
    // Vendors learn of their own turn, or of the payee's turn to confirm a sent invoice; never of internal review or send back.
    vendorVisible: party === "vendor" || (party === "deputy" && inv.status === "sent"),
    at: now,
  });
  return party;
}

async function lockInvoice(tx: Tx, id: string): Promise<Invoice> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new NotFoundError("Invoice not found.");
  return inv;
}

function snap(i: Invoice) {
  return {
    status: i.status,
    deputyPaidAt: i.deputyPaidAt,
    vendorPaidAt: i.vendorPaidAt,
    responsibleParty: i.responsibleParty,
    closedReason: i.closedReason,
  };
}

async function validatePayment(tx: Tx, input: PaymentInput, now: Date): Promise<void> {
  if (!(input.paidAt instanceof Date) || Number.isNaN(input.paidAt.getTime())) throw new ValidationError("Enter the date paid.");
  if (input.paidAt.getTime() > now.getTime()) throw new ValidationError("The paid date cannot be in the future.");
  const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, input.paymentMethodId));
  if (!m?.active) throw new ValidationError("Choose a valid payment method.");
}

/**
 * "Paid (confirmed by deputy)" for an invoice the payee's confirmation closed while the vendor has not marked it;
 * "Paid" otherwise. Owner decision 2026-11-26: the deputy's confirmation alone closes the invoice.
 */
export function paidLabel(inv: Pick<Invoice, "closedByDeputy" | "vendorPaidAt">): string {
  return inv.closedByDeputy && !inv.vendorPaidAt ? "Paid (confirmed by deputy)" : "Paid";
}

/** Deputy-confirmed and paid, but the vendor never added its own mark: the informational "Vendor not confirmed". */
export function vendorNotConfirmed(inv: Pick<Invoice, "status" | "closedByDeputy" | "vendorPaidAt">): boolean {
  return inv.status === "paid" && inv.closedByDeputy && !inv.vendorPaidAt;
}

const ISSUE_OUTCOME = { paid: "Paid", resolved: "Resolved", written_off: "Written off" } as const;

/**
 * Closes one open payment issue: stores the outcome and close time, writes the `issue_closed` timeline event
 * (not vendor-visible) and tells the payee, unless the payee closed it themselves.
 */
export async function finishIssue(
  tx: Tx,
  issue: { id: string },
  inv: Pick<Invoice, "id" | "number" | "payeeUserId">,
  outcome: keyof typeof ISSUE_OUTCOME,
  now: Date,
  actor: Actor | "system",
  note?: string | null,
): Promise<void> {
  await tx.update(paymentIssues).set({ status: outcome, closedAt: now }).where(eq(paymentIssues.id, issue.id));
  const label = ISSUE_OUTCOME[outcome];
  await tx.insert(invoiceEvents).values({
    invoiceId: inv.id,
    actorUserId: actor === "system" ? null : actor.userId,
    event: "issue_closed",
    note: note ? `${label}: ${note}` : label,
    vendorVisible: false,
    at: now,
  });
  if (actor !== "system" && actor.userId === inv.payeeUserId) return;
  const { invoiceNumberPrefix } = await getSettings(tx);
  await emit(
    tx,
    {
      recipients: [inv.payeeUserId],
      type: "payment_issue.closed",
      title: "Payment issue closed",
      body: `Your payment issue on invoice ${formatInvoiceNumber(invoiceNumberPrefix, inv.number)} was closed as ${label.toLowerCase()}.`,
      link: `/invoices/${inv.id}`,
    },
    now,
  );
}

async function closeInvoice(tx: Tx, inv: Invoice, outcome: "paid" | "written_off", now: Date, actor: Actor | "system", reason?: string): Promise<void> {
  // A closed invoice never sent leaves any queue for good; sending its paid version later queues it explicitly.
  const unqueue = inv.sentAt ? {} : { readyAt: null, paidSendQueued: false };
  await tx.update(invoices).set({ status: outcome, closedReason: reason ?? inv.closedReason, ...unqueue }).where(eq(invoices.id, inv.id));
  if (outcome === "paid") await tx.update(assignments).set({ status: "paid" }).where(eq(assignments.id, inv.assignmentId));
  const open = await tx
    .select({ id: paymentIssues.id })
    .from(paymentIssues)
    .where(and(eq(paymentIssues.invoiceId, inv.id), eq(paymentIssues.status, "open")))
    .orderBy(asc(paymentIssues.createdAt), asc(paymentIssues.id));
  // Sequential: each issue is closed with writes and audit rows in this transaction.
  for (const issue of open) await finishIssue(tx, issue, inv, outcome, now, actor);
}

/**
 * An approved invoice the deputy already marked paid (paid on the spot), still unsent or still held for review, closes
 * as paid at once: the invoice and the assignment are paid, nobody's clock runs, no email and no vendor event. Audited.
 * Sending it afterwards (if chosen) sends the paid version and never reopens it. Does nothing for any other invoice.
 */
export async function closeUnsentIfPaid(tx: Tx, invoiceId: string, now: Date, actor: Actor, reason: string): Promise<void> {
  await closePaidOnSpot(tx, invoiceId, now, actor, reason, ["approved_unsent", "pending_review"]);
}

/**
 * Closes as paid an invoice the deputy marked paid at the detail, on whichever path it was billed: sent at once,
 * queued for the vendor's next send, approved without sending, or held for review. Paid on the spot means nothing is
 * left to collect, so no response clock runs. A queued one comes off the queue; the caller queues its paid send.
 */
export async function closeIfPaidOnSpot(tx: Tx, invoiceId: string, now: Date, actor: Actor, reason: string): Promise<void> {
  await closePaidOnSpot(tx, invoiceId, now, actor, reason, ["approved_unsent", "pending_review", "sent", "ready_to_send"]);
}

async function closePaidOnSpot(tx: Tx, invoiceId: string, now: Date, actor: Actor, reason: string, statuses: Invoice["status"][]): Promise<void> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv || !statuses.includes(inv.status) || !inv.deputyPaidAt) return;
  await closeInvoice(tx, inv, "paid", now, actor);
  await applyResponsibility(tx, invoiceId, now, actor);
  const [after] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  await recordAudit(tx, { actor, action: "invoice.close", entityType: "invoice", entityId: invoiceId, before: snap(inv), after: snap(after), reason });
}

/** The payee records that they were paid (the date they received payment). */
export async function markPaid(actor: Actor, tx: Tx, invoiceId: string, input: PaymentInput, now: Date = new Date()): Promise<Invoice> {
  const inv = await lockInvoice(tx, invoiceId);
  assertCan(actor, "invoice.markPaidOwn", { ownerUserId: inv.payeeUserId });
  if (actor.userId !== inv.payeeUserId) throw new ForbiddenError("Only the person owed can mark this paid.");
  // An invoice approved without sending can be marked paid too (paid on the spot).
  if (inv.status !== "sent" && inv.status !== "approved_unsent") throw violation("not_sent", "Only a sent invoice can be marked paid.");
  if (inv.deputyPaidAt) throw violation("already_marked", "You already marked this paid");
  await validatePayment(tx, input, now);

  await tx
    .update(invoices)
    .set({ deputyPaidAt: input.paidAt, deputyMethodId: input.paymentMethodId, deputyReference: input.reference?.trim() || null })
    .where(eq(invoices.id, invoiceId));
  const note = input.note?.trim() || null;
  await tx.insert(invoiceEvents).values({ invoiceId, actorUserId: actor.userId, event: "deputy_paid", party: "deputy", note, vendorVisible: vendorEvent("deputy_paid"), at: now });
  // The payee's confirmation closes the invoice: approved but never sent (it never goes to the vendor), or sent, with
  // or without the vendor's own mark. Nobody's clock runs after it; the vendor may still add its mark for its records.
  if (inv.status === "sent") await tx.update(invoices).set({ closedByDeputy: true }).where(eq(invoices.id, invoiceId));
  await closeInvoice(tx, inv, "paid", now, actor);
  await applyResponsibility(tx, invoiceId, now, actor);
  const [updated] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  await recordAudit(tx, { actor, action: "invoice.markPaid", entityType: "invoice", entityId: invoiceId, before: snap(inv), after: snap(updated) });
  return updated;
}

/**
 * The invoice's vendor records payment on their side. On a sent invoice the payee is alerted and confirms, which
 * closes it. On one the payee already confirmed it is optional, for the vendor's records: it goes on the timeline and
 * alerts no one.
 */
export async function vendorMarkPaid(actor: Actor, tx: Tx, invoiceId: string, input: PaymentInput, now: Date = new Date()): Promise<Invoice> {
  const inv = await lockInvoice(tx, invoiceId);
  assertCan(actor, "invoice.vendorMarkPaid", { vendorId: inv.vendorId });
  if (inv.vendorPaidAt) throw violation("already_marked", "You already marked this paid");
  const afterDeputy = vendorNotConfirmed(inv);
  if (inv.status !== "sent" && !afterDeputy) throw violation("not_sent", "Only a sent invoice can be marked paid.");
  await validatePayment(tx, input, now);

  await tx
    .update(invoices)
    .set({ vendorPaidAt: input.paidAt, vendorPaidMethodId: input.paymentMethodId, vendorPaidReference: input.reference?.trim() || null })
    .where(eq(invoices.id, invoiceId));
  const note = input.note?.trim() || null;
  await tx.insert(invoiceEvents).values({ invoiceId, actorUserId: actor.userId, event: "vendor_paid", party: "vendor", note, vendorVisible: vendorEvent("vendor_paid"), at: now });
  await applyResponsibility(tx, invoiceId, now, actor);
  const [updated] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  await recordAudit(tx, { actor, action: "invoice.vendorMarkPaid", entityType: "invoice", entityId: invoiceId, before: snap(inv), after: snap(updated) });
  if (afterDeputy) return updated;
  const { invoiceNumberPrefix } = await getSettings(tx);
  const [a] = await tx.select({ jobId: assignments.jobId }).from(assignments).where(eq(assignments.id, inv.assignmentId));
  await emit(tx, { recipients: [inv.payeeUserId],
    type: "invoice.vendor_paid",
    title: "Vendor reports paid",
    body: `The vendor reports paying invoice ${formatInvoiceNumber(invoiceNumberPrefix, inv.number)}. Confirm when the money arrives.`,
    link: `/jobs/${a.jobId}`,
  });
  return updated;
}

const BACKFILL_REASON = "Owner decision 2026-11-26: the deputy's payment confirmation closes the invoice.";

/**
 * Release step, once per database: closes as paid every invoice the payee confirmed under the old two-sided rule
 * while the vendor never marked it (still sent, the vendor's turn or an open issue). Each is closed as the deputy's
 * confirmation now closes one, with a system audit entry. Safe to run again: it then finds nothing. Returns the count.
 */
export async function closeDeputyConfirmedInvoices(tx: Tx, now: Date = new Date()): Promise<number> {
  const open = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.status, "sent"), isNotNull(invoices.deputyPaidAt)))
    .orderBy(asc(invoices.number))
    .for("update");
  // Sequential: each close writes the invoice, its issues, its timeline and an audit row in this transaction.
  for (const inv of open) {
    await tx.update(invoices).set({ closedByDeputy: true }).where(eq(invoices.id, inv.id));
    await closeInvoice(tx, inv, "paid", now, "system");
    await applyResponsibility(tx, inv.id, now, "system");
    const [after] = await tx.select().from(invoices).where(eq(invoices.id, inv.id));
    await recordAudit(tx, { actor: "system", action: "invoice.close", entityType: "invoice", entityId: inv.id, before: snap(inv), after: snap(after), reason: BACKFILL_REASON });
  }
  return open.length;
}

/** A coordinator closes a sent invoice as Paid or Written off when one side never responds, or an approved, unsent one without sending it. */
export async function coordinatorCloseInvoice(actor: Actor, tx: Tx, invoiceId: string, input: CloseInput, now: Date = new Date()): Promise<Invoice> {
  assertCan(actor, "invoice.close");
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Give a reason for closing this invoice");
  if (input.outcome !== "paid" && input.outcome !== "written_off") throw new ValidationError("Choose Paid or Written off.");
  const inv = await lockInvoice(tx, invoiceId);
  if (inv.status !== "sent" && inv.status !== "approved_unsent") throw violation("not_sent", "Only a sent invoice, or one approved without sending, can be closed.");

  await closeInvoice(tx, inv, input.outcome, now, actor, reason);
  // Vendors see the outcome; invoiceTimeline strips the coordinator's reason for them.
  await tx.insert(invoiceEvents).values({
    invoiceId,
    actorUserId: actor.userId,
    event: input.outcome === "paid" ? "closed_paid" : "closed_written_off",
    note: reason,
    vendorVisible: vendorEvent(input.outcome === "paid" ? "closed_paid" : "closed_written_off"),
    at: now,
  });
  await applyResponsibility(tx, invoiceId, now, actor);
  const [updated] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  await recordAudit(tx, { actor, action: "invoice.close", entityType: "invoice", entityId: invoiceId, before: snap(inv), after: snap(updated), reason });
  return updated;
}

/** Timeline for the payee, the invoice's vendor, coordinators and admins. Vendors do not see coordinator-only events. */
export async function invoiceTimeline(actor: Actor, tx: Tx, invoiceId: string): Promise<TimelineEvent[]> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new NotFoundError("Invoice not found.");
  const staff = actor.role === "coordinator" || actor.role === "admin";
  const isVendor = actor.role === "vendor" && actor.vendorId !== null && actor.vendorId === inv.vendorId;
  const isPayee = actor.role !== "vendor" && actor.userId === inv.payeeUserId;
  if (!staff && !isVendor && !isPayee) throw new ForbiddenError();
  // A vendor sees an invoice only after it has been sent to them.
  if (isVendor && !inv.sentAt) throw new ForbiddenError();
  const rows = await tx
    .select()
    .from(invoiceEvents)
    .where(eq(invoiceEvents.invoiceId, invoiceId))
    .orderBy(asc(invoiceEvents.at), asc(invoiceEvents.createdAt), asc(invoiceEvents.id));
  if (!isVendor) return rows;
  return rows
    .filter((e) => e.vendorVisible && VENDOR_EVENTS.has(e.event))
    .map((e) => ({
      id: e.id,
      invoiceId: e.invoiceId,
      event: e.event,
      party: e.party,
      note: VENDOR_NOTE_EVENTS.has(e.event) ? e.note : null,
      at: e.at,
    }));
}
