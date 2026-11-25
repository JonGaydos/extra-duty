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
import { getSettings } from "@/domain/settings/settings";
import { minutesBetween } from "@/domain/time/agency-time";
import { currentW9 } from "@/domain/w9/w9";

export type BillInput = {
  startAt: Date;
  endAt: Date;
  changeReason?: string;
  attachW9: boolean;
  paidOnSpot?: { methodId: string; reference?: string };
};

export type BillResult = { invoice: Invoice; delivery: "sent_queued" | "held_for_review" | "ready_to_send" | "approved_unsent" };

function violation(check: string, message: string): RuleViolation {
  return new RuleViolation([{ check: `billing.${check}`, ok: false, message }], message);
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

  if (a.status === "billed" || a.status === "paid") throw violation("already_billed", "This detail is already billed");
  if (a.writtenOffAt) throw violation("written_off", "This detail was written off and cannot be billed");
  if (a.status !== "signed_up" && a.status !== "late_canceled") {
    throw violation("status", "Only a detail you worked or a late cancellation can be billed.");
  }
  const lateCancel = a.status === "late_canceled";
  // Nothing is billed before the detail's scheduled end, late-cancel pay included.
  if (lateCancel && now.getTime() < job.endAt.getTime()) throw violation("not_ended", lateCancelBillableText(job.endAt));
  if (!lateCancel && job.state === "canceled") throw violation("canceled", "This detail was canceled and cannot be billed");
  if (!lateCancel && (await isJobLocked(tx, job.id))) {
    throw violation("locked", "This detail is locked while the vendor is on payment hold");
  }

  const startAt = lateCancel ? job.startAt : input.startAt;
  const endAt = lateCancel ? job.endAt : input.endAt;
  if (!lateCancel) {
    if (now.getTime() < job.endAt.getTime()) throw violation("not_ended", "You can bill after the detail ends.");
    if (!(endAt.getTime() > startAt.getTime())) throw new ValidationError("End must be after start");
  }

  const planned = { startAt: a.plannedStartAt ?? job.startAt, endAt: a.plannedEndAt ?? job.endAt };
  const changed = !lateCancel && hoursChanged(planned, { startAt, endAt });
  const reason = input.changeReason?.trim() || null;
  if (changed && !reason) throw new ValidationError("A reason is required when the hours changed.");

  if (input.attachW9 && !(await currentW9(tx, a.userId))) throw violation("w9", "Upload your W-9 before attaching it");
  const [payee] = await tx.select({ mailingAddress: users.mailingAddress }).from(users).where(eq(users.id, a.userId));
  if (!payee?.mailingAddress?.trim()) throw violation("mailing_address", "Add your mailing address in Profile before billing");

  if (input.paidOnSpot) {
    const [m] = await tx.select().from(paymentMethods).where(eq(paymentMethods.id, input.paidOnSpot.methodId));
    if (!m || !m.active) throw new ValidationError("Choose a valid payment method.");
  }

  const settings = await getSettings(tx);
  const minimum = resolveMinimum(job.minimumBillableMinutes, vendor.minimumBillableMinutes, settings.minimumBillableMinutes);
  const rules = { minimumBillableMinutes: minimum, hourRoundingMinutes: settings.hourRoundingMinutes };
  const minutes = lateCancel
    ? lateCancelMinutes({ startAt, endAt }, { ...rules, lateCancelPayBasis: settings.lateCancelPayBasis })
    : billableMinutes(minutesBetween(startAt, endAt), rules);

  const decision = reviewDecision(settings.invoiceReviewMode, changed);
  // A vendor set to not get approved invoices by email: an invoice that needs no review is approved, not sent.
  const unsent = decision === "send" && !vendor.emailApprovedInvoices;
  // In a batch mode an invoice that needs no review waits for the vendor's next send instead of going now.
  const batched = decision === "send" && !unsent && (await isBatched(tx, vendor.id, settings));
  const send = decision === "send" && !unsent && !batched;
  const status = send ? "sent" : batched ? "ready_to_send" : unsent ? "approved_unsent" : "pending_review";
  const delivery: BillResult["delivery"] = send ? "sent_queued" : batched ? "ready_to_send" : unsent ? "approved_unsent" : "held_for_review";
  const spot = input.paidOnSpot;
  const fields = {
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
  // invoices.assignmentId is unique: a re-bill after a send back updates the returned invoice, so the number is reused.
  const [prior] = await tx.select().from(invoices).where(eq(invoices.assignmentId, assignmentId)).for("update");
  let invoice: Invoice;
  if (prior) {
    if (prior.status !== "returned") throw violation("already_billed", "This detail is already billed");
    [invoice] = await tx
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
  } else {
    const created = await createInvoice(tx, {
      assignmentId,
      minutes,
      rateCents,
      status,
    });
    [invoice] = await tx.update(invoices).set(fields).where(eq(invoices.id, created.id)).returning();
  }

  await tx
    .update(assignments)
    .set({ status: "billed", actualStartAt: startAt, actualEndAt: endAt, hoursChangeReason: reason, billedAt: now })
    .where(eq(assignments.id, assignmentId));
  await applyResponsibility(tx, invoice.id, now, actor);
  [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
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
  if (send) {
    await tx.insert(invoiceEvents).values({
      invoiceId: invoice.id,
      actorUserId: actor.userId,
      event: prior?.sentAt ? "revised" : "sent",
      vendorVisible: vendorEvent("sent"),
      at: now,
    });
    await queueInvoiceEmail(tx, invoice.id);
    // Paid on the spot: closed as paid; the email is its paid version.
    if (spot) {
      await closeIfPaidOnSpot(tx, invoice.id, now, actor, "Paid on the spot and sent as a paid invoice");
      [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
    }
  } else if (batched) {
    if (spot) {
      // Paid on the spot: closed as paid, and its paid version rides with the vendor's next send, adding nothing due.
      await closeIfPaidOnSpot(tx, invoice.id, now, actor, "Paid on the spot and queued as a paid invoice");
      await queuePaidSend(tx, invoice.id, now, actor);
    } else {
      await queueForBatch(tx, invoice.id, now, actor);
    }
    [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
  } else if (unsent) {
    await tx.insert(invoiceEvents).values({ invoiceId: invoice.id, actorUserId: actor.userId, event: "approved_unsent", vendorVisible: false, at: now });
    // Paid on the spot: nothing is left to collect, so it closes as paid.
    await closeUnsentIfPaid(tx, invoice.id, now, actor, "Paid on the spot and approved without sending");
    [invoice] = await tx.select().from(invoices).where(eq(invoices.id, invoice.id));
  } else {
    await emit(tx, {
      recipients: await coordinatorAudience(tx),
      type: "invoice.review_waiting",
      title: `Invoice ${formatInvoiceNumber(settings.invoiceNumberPrefix, invoice.number)} is waiting for review`,
      body: changed ? "The hours changed from the plan." : "The agency holds invoices for review before they go to the vendor.",
      link: `/invoices/${invoice.id}`,
    });
  }
  return { invoice, delivery };
}
