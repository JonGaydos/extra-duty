import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, invoiceEvents, invoices, jobPositions, jobs, paymentMethods, users, vendors } from "@/db/schema";
import type { Actor } from "@/domain/actor";
import { recordAudit } from "@/domain/audit/audit";
import { assertCan } from "@/domain/auth/policy";
import { applyResponsibility, closeIfPaidOnSpot, closeUnsentIfPaid, vendorEvent } from "@/domain/billing/payments";
import { billableMinutes, hoursChanged, invoiceTotal, lateCancelBillableText, lateCancelMinutes, resolveMinimum, reviewDecision } from "@/domain/billing/rules";
import { NotFoundError, RuleViolation, ValidationError } from "@/domain/errors";
import { isJobLocked } from "@/domain/vendor-portal/holds";
import { positionRateCents } from "@/domain/jobs/rate";
import { isBatched, queueForBatch, queuePaidSend } from "@/domain/invoices/batch";
import { queueInvoiceEmail } from "@/domain/invoices/email";
import { createInvoice, formatInvoiceNumber, type Invoice } from "@/domain/invoices/invoices";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";
import { getSettings, type AgencySettings } from "@/domain/settings/settings";
import { minutesBetween } from "@/domain/time/agency-time";
import { approvedW9 } from "@/domain/w9/w9";

export type BillInput = {
  startAt: Date;
  endAt: Date;
  changeReason?: string;
  attachW9: boolean;
  paidOnSpot?: { methodId: string; reference?: string };
};

export type BillResult = { invoice: Invoice; delivery: "sent_queued" | "held_for_review" | "ready_to_send" | "approved_unsent" };

type BillStatus = "sent" | "ready_to_send" | "approved_unsent" | "pending_review";

/** The new invoice's status and the delivery reported to the biller, from where the invoice goes. */
function billOutcome(send: boolean, batched: boolean, unsent: boolean): { status: BillStatus; delivery: BillResult["delivery"] } {
  if (send) return { status: "sent", delivery: "sent_queued" };
  if (batched) return { status: "ready_to_send", delivery: "ready_to_send" };
  if (unsent) return { status: "approved_unsent", delivery: "approved_unsent" };
  return { status: "pending_review", delivery: "held_for_review" };
}

function violation(check: string, message: string): RuleViolation {
  return new RuleViolation([{ check: `billing.${check}`, ok: false, message }], message);
}

type Assignment = typeof assignments.$inferSelect;
type Job = typeof jobs.$inferSelect;
type Vendor = typeof vendors.$inferSelect;
/** Where a billed invoice goes: sent now, queued for the vendor's batch, approved without sending, or (none) held for review. */
type BillRoute = { send: boolean; batched: boolean; unsent: boolean };

/** Refuses an assignment that is already billed, written off, or neither worked nor late-canceled. */
function assertBillableStatus(a: Assignment): void {
  if (a.status === "billed" || a.status === "paid") throw violation("already_billed", "This detail is already billed");
  if (a.writtenOffAt) throw violation("written_off", "This detail was written off and cannot be billed");
  if (a.status !== "signed_up" && a.status !== "late_canceled") {
    throw violation("status", "Only a detail you worked or a late cancellation can be billed.");
  }
}

/** The billed times: a late cancellation bills the job's own times, a worked detail the times given. Both only after the scheduled end. */
async function billedTimes(tx: Tx, job: Job, input: BillInput, lateCancel: boolean, now: Date): Promise<{ startAt: Date; endAt: Date }> {
  // Nothing is billed before the detail's scheduled end, late-cancel pay included.
  if (lateCancel) {
    if (now.getTime() < job.endAt.getTime()) throw violation("not_ended", lateCancelBillableText(job.endAt));
    return { startAt: job.startAt, endAt: job.endAt };
  }
  if (job.state === "canceled") throw violation("canceled", "This detail was canceled and cannot be billed");
  if (await isJobLocked(tx, job.id)) {
    throw violation("locked", "This detail is locked while the vendor is on payment hold");
  }
  const { startAt, endAt } = input;
  if (now.getTime() < job.endAt.getTime()) throw violation("not_ended", "You can bill after the detail ends.");
  // A plain > is false for an invalid date too, so a bad time is refused as well.
  const endsAfterStart = endAt.getTime() > startAt.getTime();
  if (!endsAfterStart) throw new ValidationError("End must be after start");
  return { startAt, endAt };
}

/** Refuses a bill the payee is not ready for: a W-9 attached but not approved, no mailing address, or an unknown payment method. */
async function assertPayeeReady(tx: Tx, userId: string, input: BillInput): Promise<void> {
  if (input.attachW9 && !(await approvedW9(tx, userId))) throw violation("w9", "Your W-9 must be approved before it can be attached");
  const [payee] = await tx.select({ mailingAddress: users.mailingAddress }).from(users).where(eq(users.id, userId));
  if (!payee?.mailingAddress?.trim()) throw violation("mailing_address", "Add your mailing address in Profile before billing");

  if (input.paidOnSpot) {
    const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, input.paidOnSpot.methodId));
    if (!m?.active) throw new ValidationError("Choose a valid payment method.");
  }
}

/** Billable minutes under the job, vendor or agency minimum and the agency rounding. */
function billedMinutes(job: Job, vendor: Vendor, settings: AgencySettings, lateCancel: boolean, times: { startAt: Date; endAt: Date }): number {
  const minimum = resolveMinimum(job.minimumBillableMinutes, vendor.minimumBillableMinutes, settings.minimumBillableMinutes);
  const rules = { minimumBillableMinutes: minimum, hourRoundingMinutes: settings.hourRoundingMinutes };
  return lateCancel
    ? lateCancelMinutes(times, { ...rules, lateCancelPayBasis: settings.lateCancelPayBasis })
    : billableMinutes(minutesBetween(times.startAt, times.endAt), rules);
}

async function billRoute(tx: Tx, settings: AgencySettings, vendor: Vendor, changed: boolean): Promise<BillRoute> {
  const decision = reviewDecision(settings.invoiceReviewMode, changed);
  // A vendor set to not get approved invoices by email: an invoice that needs no review is approved, not sent.
  const unsent = decision === "send" && !vendor.emailApprovedInvoices;
  // In a batch mode an invoice that needs no review waits for the vendor's next send instead of going now.
  const batched = decision === "send" && !unsent && (await isBatched(tx, vendor.id, settings));
  const send = decision === "send" && !unsent && !batched;
  return { send, batched, unsent };
}

/** The invoice columns billing sets on both a new invoice and a re-bill. */
function billFields(input: BillInput, lateCancel: boolean, send: boolean, now: Date) {
  const spot = input.paidOnSpot;
  return {
    kind: (lateCancel ? "late_cancel" : "detail") as "late_cancel" | "detail",
    attachW9: input.attachW9,
    sentAt: send ? now : null,
    // A re-bill starts out of any queue; queueForBatch below sets a new queued date when it is batched.
    readyAt: null,
    paidSendQueued: false,
    emailStatus: send ? ("queued" as const) : ("not_queued" as const),
    deputyPaidAt: spot ? now : null,
    deputyMethodId: spot ? spot.methodId : null,
    deputyReference: spot?.reference?.trim() || null,
  };
}

/**
 * Writes the invoice. invoices.assignmentId is unique: a re-bill after a send back updates the returned invoice, so
 * the number is reused. Returns the invoice and the returned one it replaced, if any.
 */
async function saveBilledInvoice(
  actor: Actor,
  tx: Tx,
  assignmentId: string,
  bill: { fields: ReturnType<typeof billFields>; minutes: number; rateCents: number; status: BillStatus },
): Promise<{ invoice: Invoice; prior: Invoice | undefined }> {
  const { fields, minutes, rateCents, status } = bill;
  const [prior] = await tx.select().from(invoices).where(eq(invoices.assignmentId, assignmentId)).for("update");
  if (!prior) {
    const created = await createInvoice(tx, {
      assignmentId,
      minutes,
      rateCents,
      status,
    });
    const [invoice] = await tx.update(invoices).set(fields).where(eq(invoices.id, created.id)).returning();
    return { invoice, prior };
  }
  if (prior.status !== "returned") throw violation("already_billed", "This detail is already billed");
  const [invoice] = await tx
    .update(invoices)
    .set({
      ...fields,
      minutes,
      rateCents,
      totalCents: invoiceTotal(minutes, rateCents),
      status,
      // A revision shows the vendor what changed after it saw the invoice; one never sent keeps its revision.
      revision: prior.sentAt ? prior.revision + 1 : prior.revision,
      minimumOverrideMinutes: null,
      closedReason: null,
    })
    .where(eq(invoices.id, prior.id))
    .returning();
  await recordAudit(tx, {
    actor,
    action: "invoice.rebill",
    entityType: "invoice",
    entityId: invoice.id,
    before: { status: prior.status, minutes: prior.minutes, totalCents: prior.totalCents, revision: prior.revision },
    after: { status: invoice.status, minutes: invoice.minutes, totalCents: invoice.totalCents, revision: invoice.revision },
  });
  return { invoice, prior };
}

const reread = async (tx: Tx, id: string): Promise<Invoice> => (await tx.select().from(invoices).where(eq(invoices.id, id)))[0];

/** After billing: sends, queues, approves or holds the invoice for review, and returns it as it now stands. */
async function deliverBill(
  actor: Actor,
  tx: Tx,
  billed: { invoice: Invoice; prior: Invoice | undefined; route: BillRoute; paidOnSpot: boolean; changed: boolean; invoiceNumberPrefix: string },
  now: Date,
): Promise<Invoice> {
  const { invoice, prior, route, paidOnSpot: spot, changed } = billed;
  if (route.send) {
    await tx.insert(invoiceEvents).values({
      invoiceId: invoice.id,
      actorUserId: actor.userId,
      event: prior?.sentAt ? "revised" : "sent",
      vendorVisible: vendorEvent("sent"),
      at: now,
    });
    await queueInvoiceEmail(tx, invoice.id);
    // Paid on the spot: closed as paid; the email is its paid version.
    if (!spot) return invoice;
    await closeIfPaidOnSpot(tx, invoice.id, now, actor, "Paid on the spot and sent as a paid invoice");
    return reread(tx, invoice.id);
  }
  if (route.batched) {
    if (spot) {
      // Paid on the spot: closed as paid, and its paid version rides with the vendor's next send, adding nothing due.
      await closeIfPaidOnSpot(tx, invoice.id, now, actor, "Paid on the spot and queued as a paid invoice");
      await queuePaidSend(tx, invoice.id, now, actor);
    } else {
      await queueForBatch(tx, invoice.id, now, actor);
    }
    return reread(tx, invoice.id);
  }
  if (route.unsent) {
    await tx.insert(invoiceEvents).values({ invoiceId: invoice.id, actorUserId: actor.userId, event: "approved_unsent", vendorVisible: false, at: now });
    // Paid on the spot: nothing is left to collect, so it closes as paid.
    await closeUnsentIfPaid(tx, invoice.id, now, actor, "Paid on the spot and approved without sending");
    return reread(tx, invoice.id);
  }
  await emit(tx, {
    recipients: await coordinatorAudience(tx),
    type: "invoice.review_waiting",
    title: `Invoice ${formatInvoiceNumber(billed.invoiceNumberPrefix, invoice.number)} is waiting for review`,
    body: changed ? "The hours changed from the plan." : "The agency holds invoices for review before they go to the vendor.",
    link: `/invoices/${invoice.id}`,
  });
  return invoice;
}

/**
 * Bills a worked detail: creates the invoice, then queues its email or holds it for review. The assignee
 * (or a coordinator or admin for them) bills after the job ends; a late-canceled assignment bills with fixed
 * times, also only after the job's scheduled end. Everything runs in the caller's transaction, so a failure (such as incomplete email
 * settings) leaves no invoice behind.
 */
export async function billAssignment(
  actor: Actor,
  tx: Tx,
  assignmentId: string,
  input: BillInput,
  now: Date = new Date(),
): Promise<BillResult> {
  const [row] = await tx
    .select({ a: assignments, job: jobs, vendor: vendors, differential: jobPositions.rateDifferentialCents })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .innerJoin(jobPositions, eq(jobPositions.id, assignments.jobPositionId))
    .innerJoin(vendors, eq(vendors.id, jobs.vendorId))
    .where(eq(assignments.id, assignmentId))
    .for("update", { of: assignments });
  if (!row) throw new NotFoundError("Assignment not found.");
  const { a, job, vendor } = row;
  // The position's rate: the detail's base rate plus the differential snapshotted on the position.
  const rateCents = positionRateCents(job.rateCents, { rateDifferentialCents: row.differential });
  assertCan(actor, "invoice.billOwn", { ownerUserId: a.userId });

  assertBillableStatus(a);
  const lateCancel = a.status === "late_canceled";
  const { startAt, endAt } = await billedTimes(tx, job, input, lateCancel, now);

  const planned = { startAt: a.plannedStartAt ?? job.startAt, endAt: a.plannedEndAt ?? job.endAt };
  const changed = !lateCancel && hoursChanged(planned, { startAt, endAt });
  const reason = input.changeReason?.trim() || null;
  if (changed && !reason) throw new ValidationError("A reason is required when the hours changed.");

  await assertPayeeReady(tx, a.userId, input);

  const settings = await getSettings(tx);
  const minutes = billedMinutes(job, vendor, settings, lateCancel, { startAt, endAt });
  const route = await billRoute(tx, settings, vendor, changed);
  const { status, delivery } = billOutcome(route.send, route.batched, route.unsent);
  const fields = billFields(input, lateCancel, route.send, now);
  const saved = await saveBilledInvoice(actor, tx, assignmentId, { fields, minutes, rateCents, status });
  const { prior } = saved;

  await tx
    .update(assignments)
    .set({ status: "billed", actualStartAt: startAt, actualEndAt: endAt, hoursChangeReason: reason, billedAt: now })
    .where(eq(assignments.id, assignmentId));
  await applyResponsibility(tx, saved.invoice.id, now, actor);
  const invoice = await reread(tx, saved.invoice.id);
  await recordAudit(tx, {
    actor,
    action: "assignment.bill",
    entityType: "assignment",
    entityId: assignmentId,
    before: { status: a.status },
    after: { status: "billed", invoiceId: invoice.id, kind: invoice.kind, minutes, delivery },
    reason: reason ?? undefined,
  });

  if (prior) {
    await tx.insert(invoiceEvents).values({ invoiceId: invoice.id, actorUserId: actor.userId, event: "rebilled", note: reason, at: now });
  }
  const final = await deliverBill(
    actor,
    tx,
    { invoice, prior, route, paidOnSpot: Boolean(input.paidOnSpot), changed, invoiceNumberPrefix: settings.invoiceNumberPrefix },
    now,
  );
  return { invoice: final, delivery };
}
