import { and, asc, desc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoiceEvents, invoices, jobs, paymentIssueNotes, paymentIssues, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import {
  applyResponsibility,
  coordinatorCloseInvoice,
  finishIssue,
  responsibleDueAt,
  vendorEvent,
  type Party,
} from "@/domain/billing/payments";
import { ForbiddenError, NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { formatInvoiceNumber, type Invoice } from "@/domain/invoices/invoices";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { agencyAllows, emit } from "@/domain/notifications/notify";
import { getSettings } from "@/domain/settings/settings";
import { queueEmail } from "@/jobs/boss";
import { simpleEmail } from "@/lib/email/format";
import type { OutgoingEmail } from "@/lib/email/types";
import { formatMoney } from "@/lib/pdf/invoice-pdf";

export type PaymentIssue = typeof paymentIssues.$inferSelect;
export type IssueOutcome = "paid" | "resolved" | "written_off";
type NoteVisibility = (typeof paymentIssueNotes.$inferSelect)["visibility"];

type ReportableInvoice = Pick<Invoice, "status" | "deputyPaidAt" | "vendorPaidAt" | "responsibleParty" | "responsibleSince"> & { hasOpenIssue: boolean };

function violation(check: string, message: string): RuleViolation {
  return new RuleViolation([{ check: `paymentIssue.${check}`, ok: false, message }], message);
}

/**
 * Spec 12.7 and 12.10. The payee may report non-payment on a sent invoice they have not marked paid, when
 * the vendor's response time is up or the vendor says it paid (the payee says it never arrived), and no
 * issue is already open.
 */
export function canReportNonPayment(invoice: ReportableInvoice, now: Date, s: { responseDays: Record<Party, number> }): boolean {
  if (invoice.status !== "sent" || invoice.deputyPaidAt || invoice.hasOpenIssue) return false;
  if (invoice.vendorPaidAt) return true;
  return (
    invoice.responsibleParty === "vendor" &&
    invoice.responsibleSince !== null &&
    now.getTime() >= responsibleDueAt("vendor", invoice.responsibleSince, s).getTime()
  );
}

async function lockInvoice(tx: Tx, id: string): Promise<Invoice> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new NotFoundError("Invoice not found.");
  return inv;
}

/** Locks the issue's invoice first (the order every writer uses), then the issue. */
async function lockIssue(tx: Tx, issueId: string): Promise<{ issue: PaymentIssue; inv: Invoice }> {
  const [found] = await tx.select({ invoiceId: paymentIssues.invoiceId }).from(paymentIssues).where(eq(paymentIssues.id, issueId));
  if (!found) throw new NotFoundError("Payment issue not found.");
  const inv = await lockInvoice(tx, found.invoiceId);
  const [issue] = await tx.select().from(paymentIssues).where(eq(paymentIssues.id, issueId)).for("update");
  return { issue, inv };
}

function requireOpen(issue: PaymentIssue): void {
  if (issue.status !== "open") throw violation("closed", "This payment issue is already closed");
}

const isStaff = (a: Actor) => a.role === "coordinator" || a.role === "admin";

/** A note appended to an alert body, or nothing when there is no note. */
const noteSuffix = (text: string | null) => (text ? ` Note: ${text}` : "");

/** The payee reports that they were not paid. Opens the issue for coordinators. */
export async function reportNonPayment(actor: Actor, tx: Tx, invoiceId: string, note?: string, now: Date = new Date()): Promise<PaymentIssue> {
  const inv = await lockInvoice(tx, invoiceId);
  assertCan(actor, "paymentIssue.report");
  if (actor.userId !== inv.payeeUserId) throw new ForbiddenError("Only the person owed can report non-payment.");
  const [existing] = await tx
    .select({ id: paymentIssues.id })
    .from(paymentIssues)
    .where(and(eq(paymentIssues.invoiceId, invoiceId), eq(paymentIssues.status, "open")));
  if (existing) throw violation("already_open", "A payment issue is already open");
  const s = await getSettings(tx);
  if (inv.status !== "sent") throw violation("not_sent", "Only a sent invoice can be reported.");
  if (inv.deputyPaidAt) throw violation("already_paid", "You already marked this paid");
  if (!canReportNonPayment({ ...inv, hasOpenIssue: false }, now, s)) {
    throw violation("vendor_time", "The vendor still has time to pay this invoice.");
  }

  const text = note?.trim() || null;
  const [issue] = await tx.insert(paymentIssues).values({ invoiceId, openedBy: actor.userId, note: text, createdAt: now, updatedAt: now }).returning();
  await tx.insert(invoiceEvents).values({ invoiceId, actorUserId: actor.userId, event: "issue_opened", party: "deputy", note: text, vendorVisible: false, at: now });
  await applyResponsibility(tx, invoiceId, now, actor);
  await recordAudit(tx, { actor, action: "paymentIssue.report", entityType: "payment_issue", entityId: issue.id, before: null, after: issue });
  const [payee] = await tx.select({ name: users.name }).from(users).where(eq(users.id, inv.payeeUserId));
  await emit(
    tx,
    {
      recipients: await coordinatorAudience(tx),
      type: "payment_issue.opened",
      title: "Non-payment reported",
      body: `${payee?.name ?? "A deputy"} reports not being paid on invoice ${formatInvoiceNumber(s.invoiceNumberPrefix, inv.number)}.${noteSuffix(text)}`,
      link: `/invoices/${invoiceId}`,
    },
    now,
  );
  return issue;
}

/**
 * Adds a note. Coordinators and admins choose `deputy` (default, the payee sees it) or `internal` (staff
 * only); the payee's own notes are always `deputy`.
 */
export async function addIssueNote(
  actor: Actor,
  tx: Tx,
  issueId: string,
  note: string,
  visibility: "internal" | "deputy" = "deputy",
  now: Date = new Date(),
): Promise<void> {
  const { issue, inv } = await lockIssue(tx, issueId);
  if (isStaff(actor)) assertCan(actor, "paymentIssue.manage");
  else {
    assertCan(actor, "paymentIssue.report");
    if (actor.userId !== inv.payeeUserId) throw new ForbiddenError();
    if (visibility === "internal") throw new ForbiddenError("Only staff can add internal notes.");
  }
  const text = note?.trim();
  if (!text) throw new ValidationError("Enter a note.");
  requireOpen(issue);
  const [row] = await tx.insert(paymentIssueNotes).values({ issueId, authorUserId: actor.userId, note: text, visibility, createdAt: now, updatedAt: now }).returning();
  // The timeline never carries internal text.
  await tx.insert(invoiceEvents).values({
    invoiceId: inv.id,
    actorUserId: actor.userId,
    event: "issue_note",
    party: isStaff(actor) ? "coordinator" : "deputy",
    note: visibility === "internal" ? null : text,
    vendorVisible: false,
    at: now,
  });
  await recordAudit(tx, { actor, action: "paymentIssue.note", entityType: "payment_issue", entityId: issueId, before: null, after: { ...row, note: visibility === "internal" ? "(internal)" : text } });
}

/** Everything an alert or email to the vendor lists about the invoice. */
async function invoiceSummary(tx: Tx, inv: Invoice, prefix: string) {
  const [row] = await tx
    .select({ jobNumber: jobs.number, jobTitle: jobs.title, payeeName: users.name })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(users, eq(users.id, inv.payeeUserId))
    .where(eq(assignments.id, inv.assignmentId));
  return {
    number: formatInvoiceNumber(prefix, inv.number),
    job: row ? `#${row.jobNumber}, ${row.jobTitle}` : "",
    amount: formatMoney(inv.totalCents),
    payee: row?.payeeName ?? "",
  };
}

/**
 * Plain email to a vendor's billing addresses, from the agency (sender settings) with the billing reply-to. `key`
 * is its entry in the notification list: when the agency turned vendor email off for it, nothing is sent ("off").
 */
export async function vendorEmail(
  tx: Tx,
  inv: Invoice,
  key: "payment_issue.waiting_on" | "invoice.vendor_payment_reminder",
  subject: string,
  intro: string,
  extra: string[] = [],
): Promise<"sent" | "no_email" | "off"> {
  if (!(await agencyAllows(tx, key, "vendor", "email"))) return "off";
  const s = await getSettings(tx);
  const [vendor] = await tx.select({ billingEmails: vendors.billingEmails }).from(vendors).where(eq(vendors.id, inv.vendorId));
  const to = vendor?.billingEmails ?? [];
  if (to.length === 0) return "no_email";
  const sum = await invoiceSummary(tx, inv, s.invoiceNumberPrefix);
  const base = simpleEmail(to[0], subject, [
    `${s.agency.name}: ${intro}`,
    `Invoice: ${sum.number}`,
    `Job: ${sum.job}`,
    `Amount: ${sum.amount}`,
    `Payee: ${sum.payee}`,
    ...extra,
  ]);
  const msg: OutgoingEmail = { ...base, to, replyTo: s.billingReplyToEmail || s.agency.email || undefined };
  await queueEmail(tx, msg);
  return "sent";
}

/** A coordinator moves the issue to wait on a party, which moves responsibility to them and alerts them. */
export async function setIssueWaitingOn(
  actor: Actor,
  tx: Tx,
  issueId: string,
  party: Party,
  note?: string,
  now: Date = new Date(),
): Promise<PaymentIssue> {
  assertCan(actor, "paymentIssue.manage");
  if (party !== "vendor" && party !== "deputy" && party !== "coordinator") throw new ValidationError("Choose who the issue waits on: the vendor, the deputy or a coordinator.");
  const { issue, inv } = await lockIssue(tx, issueId);
  requireOpen(issue);
  const text = note?.trim() || null;
  // A note to the vendor is the one note the vendor reads; the others stay with the payee and staff.
  const visibility: NoteVisibility = party === "vendor" ? "vendor" : "deputy";
  await tx.update(paymentIssues).set({ waitingOn: party }).where(eq(paymentIssues.id, issueId));
  if (text) await tx.insert(paymentIssueNotes).values({ issueId, authorUserId: actor.userId, note: text, visibility, createdAt: now, updatedAt: now });
  await tx.insert(invoiceEvents).values({
    invoiceId: inv.id,
    actorUserId: actor.userId,
    event: "issue_waiting_on",
    party,
    note: text,
    // The vendor learns only that the invoice is waiting on them; invoiceTimeline strips the note.
    vendorVisible: party === "vendor" && vendorEvent("issue_waiting_on"),
    at: now,
  });
  await applyResponsibility(tx, inv.id, now, actor);
  const [updated] = await tx.select().from(paymentIssues).where(eq(paymentIssues.id, issueId));
  await recordAudit(tx, { actor, action: "paymentIssue.waitingOn", entityType: "payment_issue", entityId: issueId, before: { waitingOn: issue.waitingOn }, after: { waitingOn: party, note: text } });

  const s = await getSettings(tx);
  const number = formatInvoiceNumber(s.invoiceNumberPrefix, inv.number);
  const link = `/invoices/${inv.id}`;
  if (party === "vendor") {
    await vendorEmail(tx, inv, "payment_issue.waiting_on", `Payment issue: invoice ${number}`, "A payment issue on this invoice is waiting on you.", text ? [`Note: ${text}`] : []);
  } else {
    const recipients = party === "deputy" ? [inv.payeeUserId] : (await coordinatorAudience(tx)).filter((id) => id !== actor.userId);
    await emit(
      tx,
      {
        recipients,
        type: "payment_issue.waiting_on",
        title: party === "deputy" ? "Payment issue needs your reply" : "Payment issue is waiting on a coordinator",
        body: `The payment issue on invoice ${number} is now waiting on ${party === "deputy" ? "you" : "a coordinator"}.${noteSuffix(text)}`,
        link,
      },
      now,
    );
  }
  return updated;
}

/**
 * Closes the issue. `paid` and `written_off` also close the invoice (as coordinatorCloseInvoice does, which
 * closes the issue with it); `resolved` closes the issue only and the invoice continues. A note is required
 * to write off.
 */
export async function closeIssue(
  actor: Actor,
  tx: Tx,
  issueId: string,
  outcome: IssueOutcome,
  note?: string,
  now: Date = new Date(),
): Promise<PaymentIssue> {
  assertCan(actor, "paymentIssue.manage");
  if (outcome !== "paid" && outcome !== "resolved" && outcome !== "written_off") throw new ValidationError("Choose Paid, Resolved or Written off.");
  const { issue, inv } = await lockIssue(tx, issueId);
  requireOpen(issue);
  const text = note?.trim() || null;
  if (outcome === "written_off" && !text) throw new ValidationError("Give a reason for writing this off");
  if (text) await tx.insert(paymentIssueNotes).values({ issueId, authorUserId: actor.userId, note: text, visibility: "deputy", createdAt: now, updatedAt: now });

  if (outcome === "resolved") {
    await finishIssue(tx, issue, inv, "resolved", now, actor, text);
    await applyResponsibility(tx, inv.id, now, actor);
  } else {
    await coordinatorCloseInvoice(actor, tx, inv.id, { outcome, reason: text ?? "Closed from a payment issue." }, now);
  }
  const [updated] = await tx.select().from(paymentIssues).where(eq(paymentIssues.id, issueId));
  await recordAudit(tx, { actor, action: "paymentIssue.close", entityType: "payment_issue", entityId: issueId, before: { status: issue.status }, after: { status: updated.status }, reason: text ?? undefined });
  return updated;
}

type IssueNoteView = { id: string; note: string; visibility: NoteVisibility; at: Date; authorUserId?: string | null };
export type PaymentIssueView = {
  id: string;
  invoiceId: string;
  status: PaymentIssue["status"];
  waitingOn: PaymentIssue["waitingOn"];
  note: string | null;
  openedAt: Date;
  closedAt: Date | null;
  notes: IssueNoteView[];
  /** What the vendor reported when it marked paid, if it did. */
  vendorPaid: { paidAt: Date; reference: string | null; note: string | null } | null;
  /** Staff only. */
  invoice?: { number: string; totalCents: number; sentAt: Date | null; deputyPaidAt: Date | null };
  vendorContact?: { vendorId: string; name: string; billingEmails: string[] };
};

/**
 * The issue for the payee and for coordinators and admins. The payee never sees internal notes, vendor
 * contact or author ids; vendors have no access.
 */
export async function getPaymentIssue(actor: Actor, tx: Tx, issueId: string): Promise<PaymentIssueView> {
  const [issue] = await tx.select().from(paymentIssues).where(eq(paymentIssues.id, issueId));
  if (!issue) throw new NotFoundError("Payment issue not found.");
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, issue.invoiceId));
  const staff = isStaff(actor);
  if (!staff && !(actor.role !== "vendor" && actor.userId === inv.payeeUserId)) throw new ForbiddenError();
  const rows = await tx
    .select()
    .from(paymentIssueNotes)
    .where(eq(paymentIssueNotes.issueId, issueId))
    .orderBy(asc(paymentIssueNotes.createdAt), asc(paymentIssueNotes.id));
  const notes = rows
    .filter((n) => staff || n.visibility !== "internal")
    .map((n) => ({ id: n.id, note: n.note, visibility: n.visibility, at: n.createdAt, ...(staff ? { authorUserId: n.authorUserId } : {}) }));
  let vendorPaid: PaymentIssueView["vendorPaid"] = null;
  if (inv.vendorPaidAt) {
    const [ev] = await tx
      .select({ note: invoiceEvents.note })
      .from(invoiceEvents)
      .where(and(eq(invoiceEvents.invoiceId, inv.id), eq(invoiceEvents.event, "vendor_paid")))
      .orderBy(desc(invoiceEvents.at), desc(invoiceEvents.id))
      .limit(1);
    vendorPaid = { paidAt: inv.vendorPaidAt, reference: inv.vendorPaidReference, note: ev?.note ?? null };
  }
  const view: PaymentIssueView = {
    id: issue.id,
    invoiceId: issue.invoiceId,
    status: issue.status,
    waitingOn: issue.waitingOn,
    note: issue.note,
    openedAt: issue.createdAt,
    closedAt: issue.closedAt,
    notes,
    vendorPaid,
  };
  if (!staff) return view;
  const s = await getSettings(tx);
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, inv.vendorId));
  return {
    ...view,
    invoice: { number: formatInvoiceNumber(s.invoiceNumberPrefix, inv.number), totalCents: inv.totalCents, sentAt: inv.sentAt, deputyPaidAt: inv.deputyPaidAt },
    vendorContact: { vendorId: vendor.id, name: vendor.name, billingEmails: vendor.billingEmails },
  };
}

export type VendorIssueRow = {
  issueId: string;
  invoiceId: string;
  invoiceNumber: string;
  totalCents: number;
  status: PaymentIssue["status"];
  openedAt: Date;
  closedAt: Date | null;
};

/** A vendor's open and past issues, newest first. Coordinators and admins only. */
export async function vendorIssueHistory(actor: Actor, tx: Tx, vendorId: string): Promise<VendorIssueRow[]> {
  assertCan(actor, "paymentIssue.manage");
  const { invoiceNumberPrefix } = await getSettings(tx);
  const rows = await tx
    .select({ issue: paymentIssues, number: invoices.number, totalCents: invoices.totalCents })
    .from(paymentIssues)
    .innerJoin(invoices, eq(invoices.id, paymentIssues.invoiceId))
    .where(eq(invoices.vendorId, vendorId))
    .orderBy(desc(paymentIssues.createdAt), desc(paymentIssues.id));
  return rows.map((r) => ({
    issueId: r.issue.id,
    invoiceId: r.issue.invoiceId,
    invoiceNumber: formatInvoiceNumber(invoiceNumberPrefix, r.number),
    totalCents: r.totalCents,
    status: r.issue.status,
    openedAt: r.issue.createdAt,
    closedAt: r.issue.closedAt,
  }));
}
