import { asc, eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoiceEvents, invoices, jobs, users, vendors } from "@/db/schema";
import { emit } from "@/domain/notifications/notify";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { applyResponsibility, closeUnsentIfPaid, vendorEvent } from "@/domain/billing/payments";
import { billableMinutes, invoiceTotal, lateCancelMinutes, resolveMinimum } from "@/domain/billing/rules";
import { NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { isBatched, queueForBatch, queuePaidSend } from "@/domain/invoices/batch";
import { queueInvoiceEmail, queueInvoiceResend } from "@/domain/invoices/email";
import { normalizeEmail } from "@/domain/auth/sign-in-policy";
import { formatInvoiceNumber, type Invoice } from "@/domain/invoices/invoices";
import { getSettings } from "@/domain/settings/settings";
import { minutesBetween } from "@/domain/time/agency-time";
import { currentW9 } from "@/domain/w9/w9";
import type { Cents, Minutes } from "@/domain/types";
import { isEmail } from "@/lib/is-email";

export type EditInvoiceInput = {
  startAt?: Date;
  endAt?: Date;
  rateCents?: Cents;
  /** Applies to this invoice only; wins over the job, vendor and agency minimums. */
  minimumBillableMinutes?: Minutes;
  reason: string;
};

export type ReviewRow = {
  id: string;
  number: number;
  payeeName: string;
  vendorName: string;
  jobNumber: number;
  jobTitle: string;
  minutes: Minutes;
  workedMinutes: Minutes;
  totalCents: Cents;
  changeReason: string | null;
  createdAt: Date;
};

function violation(check: string, message: string): RuleViolation {
  return new RuleViolation([{ check: `invoice.${check}`, ok: false, message }], message);
}

async function lockInvoice(tx: Tx, id: string): Promise<Invoice> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
  if (!inv) throw new NotFoundError("Invoice not found.");
  return inv;
}

function snapshot(i: Invoice) {
  return {
    status: i.status,
    minutes: i.minutes,
    rateCents: i.rateCents,
    totalCents: i.totalCents,
    revision: i.revision,
    minimumOverrideMinutes: i.minimumOverrideMinutes,
    emailStatus: i.emailStatus,
    attachW9: i.attachW9,
    w9RequestedBy: i.w9RequestedBy,
  };
}

export type ApproveOptions = {
  /** Attach the payee's current W-9 even though they did not choose it; the read is audited as this coordinator. */
  attachW9?: boolean;
  /**
   * Send it to the vendor (true) or approve it without sending (false). Left out, the vendor's "Email approved
   * invoices to this vendor" setting decides.
   */
  send?: boolean;
};

/**
 * The normal send path for an approved invoice: when the vendor's invoices go out in batches it joins the queue
 * (status ready_to_send) and is emailed with the batch; otherwise status sent, responsible party vendor, email
 * queued. A paid invoice goes the same way but stays paid and closed: the queue marks it by its queued date, the
 * send sets its sent date, and no response clock or responsibility change follows. The caller audits.
 */
async function release(actor: Actor, tx: Tx, id: string, vendorId: string, now: Date): Promise<Invoice> {
  const [cur] = await tx.select().from(invoices).where(eq(invoices.id, id));
  const paid = cur.status === "paid";
  if (await isBatched(tx, vendorId, await getSettings(tx))) {
    if (paid) {
      await queuePaidSend(tx, id, now, actor);
    } else {
      await queueForBatch(tx, id, now, actor);
    }
    return (await tx.select().from(invoices).where(eq(invoices.id, id)))[0];
  }
  if (paid) {
    await tx.update(invoices).set({ sentAt: now }).where(eq(invoices.id, id));
  } else {
    await tx.update(invoices).set({ status: "sent", sentAt: now }).where(eq(invoices.id, id));
    await applyResponsibility(tx, id, now, actor);
  }
  await tx.insert(invoiceEvents).values({ invoiceId: id, actorUserId: actor.userId, event: "sent", vendorVisible: vendorEvent("sent"), at: now });
  await queueInvoiceEmail(tx, id);
  return (await tx.select().from(invoices).where(eq(invoices.id, id)))[0];
}

/** Whether "Send now" (unpaid) or "Send paid invoice" applies: approved, never sent and not queued. */
export function sendableLater(inv: Pick<Invoice, "status" | "deputyPaidAt" | "sentAt" | "paidSendQueued">): "unsent" | "paid" | null {
  if (inv.status === "approved_unsent" && !inv.deputyPaidAt) return "unsent";
  if (inv.status === "paid" && !inv.sentAt && !inv.paidSendQueued) return "paid";
  return null;
}

/**
 * Approves a held invoice. Sent: it follows the normal send path (see release). Not sent: status approved_unsent,
 * with no email, no batch, no sent date and no vendor-visible event, so the vendor does not see it and nobody's
 * response clock runs until a coordinator sends it (sendApprovedInvoice). No reason is needed either way.
 */
export async function approveInvoice(actor: Actor, tx: Tx, id: string, now: Date = new Date(), opts: ApproveOptions = {}): Promise<Invoice> {
  assertCan(actor, "invoice.review");
  let inv = await lockInvoice(tx, id);
  const original = inv;
  if (inv.status !== "pending_review") throw violation("not_pending", "Only an invoice waiting for review can be approved.");
  if (opts.send !== undefined && typeof opts.send !== "boolean") throw new ValidationError("Choose whether to send the invoice.");
  if (opts.attachW9 && !inv.attachW9) {
    if (!(await currentW9(tx, inv.payeeUserId))) {
      const [payee] = await tx.select({ name: users.name }).from(users).where(eq(users.id, inv.payeeUserId));
      throw violation("w9_missing", `${payee?.name ?? "The payee"} has no W-9 on file, so it cannot be attached.`);
    }
    [inv] = await tx.update(invoices).set({ attachW9: true, w9RequestedBy: actor.userId }).where(eq(invoices.id, id)).returning();
  }
  const send = opts.send ?? (await tx.select({ v: vendors.emailApprovedInvoices }).from(vendors).where(eq(vendors.id, inv.vendorId)))[0]?.v ?? true;
  let after: Invoice;
  if (send) {
    // Paid on the spot: it closes as paid and the paid version is sent.
    await closeUnsentIfPaid(tx, id, now, actor, "Paid on the spot; approved and sent as a paid invoice");
    after = await release(actor, tx, id, inv.vendorId, now);
  } else {
    await tx.update(invoices).set({ status: "approved_unsent", sentAt: null, readyAt: null, batchId: null, emailStatus: "not_queued" }).where(eq(invoices.id, id));
    await applyResponsibility(tx, id, now, actor);
    await tx.insert(invoiceEvents).values({ invoiceId: id, actorUserId: actor.userId, event: "approved_unsent", vendorVisible: false, at: now });
    // Already paid on the spot: it closes as paid instead of waiting to be sent.
    await closeUnsentIfPaid(tx, id, now, actor, "Paid on the spot and approved without sending");
    after = (await tx.select().from(invoices).where(eq(invoices.id, id)))[0];
  }
  await recordAudit(tx, {
    actor,
    action: "invoice.approve",
    entityType: "invoice",
    entityId: id,
    before: snapshot(original),
    after: { ...snapshot(after), send },
  });
  return after;
}

/**
 * "Send now" for an invoice approved without sending, or "Send paid invoice" for a paid one never sent (it goes out
 * marked paid and stays closed). Either follows the normal send path, the vendor's schedule and batching included.
 * Audited. Refused for anything else, a written-off invoice included.
 */
export async function sendApprovedInvoice(actor: Actor, tx: Tx, id: string, now: Date = new Date()): Promise<Invoice> {
  assertCan(actor, "invoice.review");
  const inv = await lockInvoice(tx, id);
  if (!sendableLater(inv)) throw violation("not_unsent", "Only an invoice approved without sending, or a paid one never sent, can be sent this way.");
  const after = await release(actor, tx, id, inv.vendorId, now);
  await recordAudit(tx, { actor, action: "invoice.send", entityType: "invoice", entityId: id, before: snapshot(inv), after: snapshot(after) });
  return after;
}

/**
 * Emails an invoice already sent again, as it stands (a paid one as its paid version): to the vendor's billing
 * emails and, optionally, one extra address that is not saved anywhere. The revision, the sent date and the
 * response clocks do not change. A staff-only `resent` event and an audit row name the recipients.
 */
export async function resendInvoice(actor: Actor, tx: Tx, id: string, input: { alsoTo?: string | null }, now: Date = new Date()): Promise<{ to: string[] }> {
  assertCan(actor, "invoice.review");
  const inv = await lockInvoice(tx, id);
  if (!inv.sentAt || inv.status === "returned") throw violation("not_sent", "Only an invoice that has been sent can be resent.");
  const raw = typeof input.alsoTo === "string" ? input.alsoTo.trim() : "";
  const extra = raw ? normalizeEmail(raw) : null;
  if (raw && (!extra || !isEmail(extra))) throw new ValidationError(`"${raw}" is not a valid email address.`);
  const [vendor] = await tx.select({ billingEmails: vendors.billingEmails }).from(vendors).where(eq(vendors.id, inv.vendorId));
  const billing = vendor?.billingEmails ?? [];
  const to = [...new Set([...billing, ...(extra ? [extra] : [])])];
  // The billing emails get the invoice as before, W-9 included when it attaches one (read as this coordinator). When
  // it does, an extra address gets its own email without the W-9.
  if (inv.attachW9 && extra && !billing.includes(extra)) {
    await queueInvoiceResend(tx, id, billing, { w9ReadBy: actor.userId });
    await queueInvoiceResend(tx, id, [extra], { noW9: true });
  } else {
    await queueInvoiceResend(tx, id, to, { w9ReadBy: actor.userId });
  }
  await tx.insert(invoiceEvents).values({ invoiceId: id, actorUserId: actor.userId, event: "resent", note: `To ${to.join(", ")}`, vendorVisible: false, at: now });
  await recordAudit(tx, {
    actor,
    action: "invoice.resend",
    entityType: "invoice",
    entityId: id,
    before: { emailStatus: inv.emailStatus },
    after: { to, revision: inv.revision, w9To: inv.attachW9 ? billing : [] },
  });
  return { to };
}

const isWholeNonNegative = (n: number | undefined) => n === undefined || (Number.isInteger(n) && n >= 0);

/** Refuses a correction the invoice's status or kind does not allow, or a rate or minimum that is not a whole, non-negative number. */
function assertEditable(inv: Invoice, input: EditInvoiceInput): void {
  if (inv.status !== "pending_review" && inv.status !== "ready_to_send" && inv.status !== "approved_unsent" && inv.status !== "sent") {
    throw violation("not_editable", "Only an invoice waiting for review, approved, ready to send or already sent can be edited.");
  }
  if (inv.kind === "late_cancel" && (input.startAt || input.endAt)) throw new ValidationError("A late cancellation has fixed times.");
  if (!isWholeNonNegative(input.rateCents)) throw new ValidationError("Rate must be a non-negative integer number of cents.");
  if (!isWholeNonNegative(input.minimumBillableMinutes)) throw new ValidationError("Minimum must be a non-negative integer number of minutes.");
}

/**
 * Corrects a pending or sent invoice and recomputes it. A pending invoice stays pending (approve it
 * separately). A sent invoice gets the next revision and is emailed again as Revised.
 */
export async function editInvoice(actor: Actor, tx: Tx, id: string, input: EditInvoiceInput): Promise<Invoice> {
  assertCan(actor, "invoice.review");
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Give a reason for the change");
  const inv = await lockInvoice(tx, id);
  assertEditable(inv, input);
  const lateCancel = inv.kind === "late_cancel";

  const [row] = await tx
    .select({ a: assignments, job: jobs, vendor: vendors })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(eq(assignments.id, inv.assignmentId))
    .for("update", { of: assignments });
  if (!row) throw new NotFoundError("Assignment not found.");
  const { a, job, vendor } = row;

  const startAt = input.startAt ?? a.actualStartAt ?? a.plannedStartAt ?? job.startAt;
  const endAt = input.endAt ?? a.actualEndAt ?? a.plannedEndAt ?? job.endAt;
  // A plain > is false for an invalid date too, so a bad time is refused as well.
  const endsAfterStart = endAt.getTime() > startAt.getTime();
  if (!lateCancel && !endsAfterStart) throw new ValidationError("End must be after start");

  const settings = await getSettings(tx);
  const overrideMinutes = input.minimumBillableMinutes ?? inv.minimumOverrideMinutes;
  const minimum =
    overrideMinutes ?? resolveMinimum(job.minimumBillableMinutes, vendor.minimumBillableMinutes, settings.minimumBillableMinutes);
  const rules = { minimumBillableMinutes: minimum, hourRoundingMinutes: settings.hourRoundingMinutes };
  const curStart = a.actualStartAt ?? a.plannedStartAt ?? job.startAt;
  const curEnd = a.actualEndAt ?? a.plannedEndAt ?? job.endAt;
  const timesChanged = !lateCancel && (startAt.getTime() !== curStart.getTime() || endAt.getTime() !== curEnd.getTime());
  const minimumChanged = overrideMinutes !== inv.minimumOverrideMinutes;
  // Minutes are recomputed only when the times or this invoice's minimum change. Otherwise they stay as billed:
  // a rate-only correction never picks up rounding or a minimum that changed in the settings since billing.
  let minutes = inv.minutes;
  if (timesChanged || minimumChanged) {
    minutes = lateCancel
      ? lateCancelMinutes({ startAt: job.startAt, endAt: job.endAt }, { ...rules, lateCancelPayBasis: settings.lateCancelPayBasis })
      : billableMinutes(minutesBetween(startAt, endAt), rules);
  }
  const rateCents = input.rateCents ?? inv.rateCents;
  const resend = inv.status === "sent";
  if (rateCents === inv.rateCents && !minimumChanged && !timesChanged) throw new ValidationError("Nothing changed");

  const [updated] = await tx
    .update(invoices)
    .set({
      minutes,
      rateCents,
      totalCents: invoiceTotal(minutes, rateCents),
      minimumOverrideMinutes: overrideMinutes,
      revision: resend ? inv.revision + 1 : inv.revision,
    })
    .where(eq(invoices.id, id))
    .returning();
  if (!lateCancel && (input.startAt || input.endAt)) {
    await tx
      .update(assignments)
      .set({ actualStartAt: startAt, actualEndAt: endAt })
      .where(eq(assignments.id, a.id));
  }
  await recordAudit(tx, {
    actor,
    action: "invoice.edit",
    entityType: "invoice",
    entityId: id,
    before: { ...snapshot(inv), startAt: a.actualStartAt, endAt: a.actualEndAt },
    after: { ...snapshot(updated), startAt, endAt },
    reason,
  });
  await tx.insert(invoiceEvents).values({ invoiceId: id, actorUserId: actor.userId, event: "edited", note: reason });
  const { invoiceNumberPrefix } = await getSettings(tx);
  await emit(tx, {
    recipients: [inv.payeeUserId],
    type: "invoice.edited",
    title: `Invoice ${formatInvoiceNumber(invoiceNumberPrefix, inv.number)} was edited`,
    body: reason,
    link: `/jobs/${a.jobId}`,
  });
  if (resend) {
    await tx.insert(invoiceEvents).values({ invoiceId: id, actorUserId: actor.userId, event: "revised", vendorVisible: vendorEvent("revised") });
    await queueInvoiceEmail(tx, id);
    const [final] = await tx.select().from(invoices).where(eq(invoices.id, id));
    return final;
  }
  return updated;
}

/**
 * Returns an invoice to the person who billed it. The assignment goes back to signed up with its actual
 * times cleared (the audit row keeps them), and the person re-bills on the same invoice number.
 */
export async function sendBackInvoice(actor: Actor, tx: Tx, id: string, comment?: string, now: Date = new Date()): Promise<Invoice> {
  assertCan(actor, "invoice.review");
  const inv = await lockInvoice(tx, id);
  if (inv.status !== "pending_review" && inv.status !== "ready_to_send" && inv.status !== "approved_unsent" && inv.status !== "sent") {
    throw violation("not_returnable", "Only an invoice waiting for review, approved, ready to send or already sent can be sent back.");
  }
  const [a] = await tx.select().from(assignments).where(eq(assignments.id, inv.assignmentId)).for("update");
  if (!a) throw new NotFoundError("Assignment not found.");
  const note = comment?.trim() || null;
  // A late cancellation re-bills as one: it goes back to late_canceled, a worked detail to signed_up.
  const restored = inv.kind === "late_cancel" ? "late_canceled" : "signed_up";

  await tx
    .update(invoices)
    // Clearing the batch keeps a later retry of that batch's email from picking this invoice up again.
    .set({ status: "returned", emailStatus: "not_queued", batchId: null, readyAt: null, paidSendQueued: false })
    .where(eq(invoices.id, id));
  await tx
    .update(assignments)
    .set({ status: restored, actualStartAt: null, actualEndAt: null, billedAt: null })
    .where(eq(assignments.id, a.id));
  await applyResponsibility(tx, id, now, actor);
  await tx.insert(invoiceEvents).values({ invoiceId: id, actorUserId: actor.userId, event: "returned", note, at: now });
  const [updated] = await tx.select().from(invoices).where(eq(invoices.id, id));
  await recordAudit(tx, {
    actor,
    action: "invoice.send_back",
    entityType: "invoice",
    entityId: id,
    before: { ...snapshot(inv), assignmentStatus: a.status, startAt: a.actualStartAt, endAt: a.actualEndAt, billedAt: a.billedAt },
    after: { ...snapshot(updated), assignmentStatus: restored },
    reason: note ?? undefined,
  });
  const { invoiceNumberPrefix } = await getSettings(tx);
  const number = formatInvoiceNumber(invoiceNumberPrefix, inv.number);
  await emit(tx, { recipients: [inv.payeeUserId],
    type: "invoice.returned",
    title: `Invoice ${number} was sent back`,
    body: note ?? "A coordinator sent this invoice back. Review the hours and bill it again.",
    link: `/jobs/${a.jobId}`,
  });
  return updated;
}

/** Invoices waiting for review, oldest first. */
export async function listInvoicesForReview(actor: Actor, tx: Tx): Promise<ReviewRow[]> {
  assertCan(actor, "invoice.review");
  const rows = await tx
    .select({ inv: invoices, payeeName: users.name, vendorName: vendors.name, job: jobs, a: assignments })
    .from(invoices)
    .innerJoin(users, eq(users.id, invoices.payeeUserId))
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .innerJoin(assignments, eq(assignments.id, invoices.assignmentId))
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(eq(invoices.status, "pending_review"))
    .orderBy(asc(invoices.createdAt), asc(invoices.number));
  return rows.map(({ inv, payeeName, vendorName, job, a }) => ({
    id: inv.id,
    number: inv.number,
    payeeName,
    vendorName,
    jobNumber: job.number,
    jobTitle: job.title,
    minutes: inv.minutes,
    workedMinutes:
      inv.kind === "late_cancel"
        ? 0
        : minutesBetween(a.actualStartAt ?? a.plannedStartAt ?? job.startAt, a.actualEndAt ?? a.plannedEndAt ?? job.endAt),
    totalCents: inv.totalCents,
    changeReason: a.hoursChangeReason,
    createdAt: inv.createdAt,
  }));
}
