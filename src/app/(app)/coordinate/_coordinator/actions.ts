"use server";

import { assignPerson, liftVendorRestriction, markNoShow, removePerson, restrictFromVendor } from "@/domain/assignments/coordinator";
import { overrideBillingLock } from "@/domain/billing/lock";
import { coordinatorCloseInvoice } from "@/domain/billing/payments";
import { editDeputyNote, retireDeputyNote, reviewDeputyNote } from "@/domain/deputy-notes/deputy-notes";
import { ValidationError } from "@/domain/errors";
import { sendInvoiceBatch, setWaitForAllDeputies } from "@/domain/invoices/batch";
import { approveInvoice, editInvoice, resendInvoice, sendApprovedInvoice, sendBackInvoice } from "@/domain/invoices/review";
import type { SendSchedule } from "@/domain/invoices/send-schedule";
import { copyJob, createJobsOnDates, createRecurringJobs } from "@/domain/jobs/copy";
import { cancelJob, createJob, holdJob, reactivateJob, releaseJob, updateJob, type JobInput } from "@/domain/jobs/jobs";
import { applyEdit, previewEdit, seriesIds, type EditPatch } from "@/domain/jobs/bulk-edit";
import { decideQualificationRequest } from "@/domain/jobs/qualifications";
import { addDays, expandSelection, type DateSelection, type Recurrence } from "@/domain/jobs/recurrence";
import { resolveSafetyPins } from "@/domain/jobs/safety";
import { suggestPriorPlan } from "@/domain/ops-plans/library";
import { nameIc, reviewOpsPlan } from "@/domain/ops-plans/ops-plans";
import { addIssueNote, closeIssue, setIssueWaitingOn, type IssueOutcome } from "@/domain/payment-issues/issues";
import type { Party } from "@/domain/billing/payments";
import { runReport, type ReportSpec } from "@/domain/reports/engine";
import { deleteSavedReport, saveReport } from "@/domain/reports/saved";
import { agencyDateOnly, agencyDayKey } from "@/domain/time/agency-time";
import { approveJobChange, approveRequest, declineJobChange, declineRequest, waiveLateCancelPay } from "@/domain/vendor-portal/requests";
import { addLocation, addVendorDocument, createVendor, createVendorLogin, placePaymentHold, resolvePaymentHold, setLocationActive, updateVendor, type LocationInput, type VendorInput } from "@/domain/vendors/vendors";
import { addVendorContact, addVendorContactForJob } from "@/domain/vendors/contacts";
import { assertCan, isVendorManager } from "@/domain/auth/policy";
import { jobVendorId } from "@/domain/auth/scope";
import type { Actor } from "@/domain/actor";
import { withTx } from "@/ui/shell/request";
import { act, actOutsideTx, type ActionResult } from "../../_personnel/result";
import { detailInput, onDay, overrideSpanOn, parseDollars, type DetailWire } from "./detail-input";
import { plural } from "../../_personnel/format";
import { byText } from "@/lib/sort";

/** Server actions for the coordinator screens: each checks the person, calls one service and reports back. */

const KEY_DAY = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });
/** "Tue, Dec 1" for an agency date key. */
const keyDay = (key: string) => KEY_DAY.format(new Date(`${key}T12:00:00Z`));

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Staff, or a vendor manager (whose vendor is checked when the detail is saved). */
function assertCanCreateSome(actor: Actor): void {
  if (!isVendorManager(actor)) assertCan(actor, "job.create");
}

/** Dates for a Range or Repeat selection, as a JSON list of agency date keys. */
export async function expandDatesAction(selection: DateSelection, firstDate: string): Promise<ActionResult> {
  // act() takes a promise-returning callback; nothing here waits, so the result is returned already resolved.
  return act((actor) => {
    assertCanCreateSome(actor);
    return Promise.resolve({ ok: true, value: JSON.stringify(expandSelection(selection, firstDate)) });
  });
}

/** Last year's agreed plan for a repeat event, as JSON (or nothing). */
export async function suggestPlanAction(input: { vendorId: string; title: string; date: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    assertCan(actor, "job.create", { vendorId: input.vendorId || undefined });
    if (!input.vendorId || !input.title.trim() || !DATE.test(input.date)) return { ok: true };
    const s = await suggestPriorPlan(tx, { vendorId: input.vendorId, title: input.title, startAt: onDay(input.date, "12:00", "Date") });
    return { ok: true, value: s ? JSON.stringify({ year: s.year, title: s.jobTitle, versionId: s.versionId, filename: s.filename }) : undefined };
  });
}

/**
 * Creates one detail, or one per date as a single series (all or nothing; a failing date names itself).
 * `fromJobId` copies that job's attachments onto every new detail.
 */
export async function createDetailsAction(input: { detail: DetailWire; dates: string[]; overrides: Record<string, { startTime?: string; endTime?: string }>; fromJobId?: string }): Promise<ActionResult> {
  return actOutsideTx(async (actor) => {
    assertCan(actor, "job.create", { vendorId: input.detail.vendorId || undefined });
    const dates = [...new Set(input.dates)].sort(byText);
    if (dates.length === 0) throw new ValidationError("Choose at least one date.");
    let base = detailInput(input.detail, dates[0]);
    // A changed time on one date is checked here so the message names that date, as the service's own do.
    for (const date of dates) {
      const o = input.overrides[date];
      if (!o) continue;
      try {
        overrideSpanOn(date, o.startTime || input.detail.startTime, o.endTime || input.detail.endTime);
      } catch (e) {
        if (e instanceof ValidationError) throw new ValidationError(`${date}: ${e.message}`);
        throw e;
      }
    }
    // Address lookups happen before the transaction opens.
    if (base.safety) base = { ...base, safety: await resolveSafetyPins(base.safety) };
    return withTx(async (tx) => {
      if (input.detail.newContact) {
        const c = await addVendorContact(actor, tx, base.vendorId, input.detail.newContact);
        base = { ...base, contactName: c.name, contactPhone: c.phone };
      }
      if (dates.length === 1 && !input.fromJobId) {
        const o = input.overrides[dates[0]];
        const span = o ? overrideSpanOn(dates[0], o.startTime ?? input.detail.startTime, o.endTime ?? input.detail.endTime) : {};
        const job = await createJob(actor, tx, { ...base, ...span });
        return { ok: true, value: job.id, message: "Detail created." };
      }
      const made = await createJobsOnDates(actor, tx, base, dates, input.overrides, input.fromJobId ? { attachmentsFromJobId: input.fromJobId } : {});
      return { ok: true, value: made[0].id, message: made.length === 1 ? "Detail created." : `${made.length} details created in one series.` };
    });
  });
}

/** Saves the editor. `scope` series applies to this and later details; times change one detail at a time. */
export async function updateDetailAction(input: { jobId: string; detail: DetailWire; date: string; scope: "one" | "series"; conflictOverride?: { reason: string; fingerprints: Record<string, string> } }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const full = detailInput({ ...input.detail, safetyNotes: "", safetyAddresses: [] }, input.date);
    const patch: Partial<JobInput> = { ...full };
    const fingerprint = input.conflictOverride?.fingerprints[input.jobId];
    if (input.conflictOverride?.reason.trim() && fingerprint) patch.conflictOverride = { reason: input.conflictOverride.reason, fingerprint };
    // The editor never moves a job to another vendor, and officer safety and the ops plan due date have their own paths.
    delete patch.vendorId;
    delete patch.safety;
    delete patch.opsPlanDueAt;
    if (input.detail.newContact) {
      const c = await addVendorContactForJob(actor, tx, input.jobId, input.detail.newContact);
      Object.assign(patch, { contactName: c.name, contactPhone: c.phone });
    }
    if (input.scope === "series") {
      delete patch.startAt;
      delete patch.endAt;
      delete patch.flex;
      // An approved out-of-range rate belongs to one detail; a series edit never carries it.
      delete patch.rateOverrideReason;
    }
    const saved = await updateJob(actor, tx, input.jobId, patch, input.scope);
    return { ok: true, message: saved.length === 1 ? "Saved." : `Saved ${saved.length} details.` };
  });
}

export async function saveSafetyAction(input: { jobId: string; notes: string; addresses: Array<{ address: string; description: string; lat?: number | null; lng?: number | null; source?: "auto" | "manual" }> }): Promise<ActionResult> {
  return actOutsideTx(async (actor) => {
    assertCan(actor, "job.update", { vendorId: await withTx((tx) => jobVendorId(tx, input.jobId)) });
    const safety = await resolveSafetyPins({ notes: input.notes, addresses: input.addresses.filter((a) => a.address.trim()) });
    return withTx(async (tx) => {
      await updateJob(actor, tx, input.jobId, { safety }, "one");
      return { ok: true, message: "Officer safety saved." };
    });
  });
}

/** `vendor_hold` cancels a locked detail; late cancellation pay follows the hold time unless `applyLateCancelPay`. */
export async function cancelDetailAction(input: { jobId: string; reason: string; cause?: "vendor_hold" | "vendor"; applyLateCancelPay?: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await cancelJob(actor, tx, input.jobId, input.reason, { cause: input.cause, applyLateCancelPay: input.applyLateCancelPay });
    return { ok: true, message: "Detail canceled." };
  });
}

export async function reactivateDetailAction(input: { jobId: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await reactivateJob(actor, tx, input.jobId, input.reason);
    return { ok: true, message: "Detail reactivated. The people who were on it and the vendor were told." };
  });
}

export async function holdDetailAction(input: { jobId: string; scope: "one" | "series" }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const done = await holdJob(actor, tx, input.jobId, input.scope === "series" ? "series" : "one");
    return { ok: true, message: done.length === 1 ? "Held. It is off the open lists and takes no new sign-ups." : `${done.length} details held. They are off the open lists and take no new sign-ups.` };
  });
}

/** "Released. Open for sign-up now.", or when the released details open. */
function releasedMessage(count: number, now: boolean): string {
  const what = count === 1 ? "Released" : `${count} details released`;
  if (now) return `${what}. Open for sign-up now.`;
  return `${what}. ${count === 1 ? "It opens" : "They open"} at the normal release time.`;
}

/** Clears the hold; `now` also opens details whose release time has not come. */
export async function releaseDetailAction(input: { jobId: string; scope: "one" | "series"; now: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const done = await releaseJob(actor, tx, input.jobId, { scope: input.scope === "series" ? "series" : "one", now: input.now === true });
    return { ok: true, message: releasedMessage(done.length, input.now) };
  });
}

export async function approveRequestAction(jobId: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const done = await approveRequest(actor, tx, jobId);
    return { ok: true, message: done.length === 1 ? "Request approved." : `Request approved for ${done.length} dates.` };
  });
}

export async function declineRequestAction(input: { jobId: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await declineRequest(actor, tx, input.jobId, input.reason);
    return { ok: true, message: "Request declined. The vendor was told why." };
  });
}

export async function decideChangeAction(input: { requestId: string; approve: boolean; reason: string; jobId?: string; conflictOverride?: { reason: string; fingerprints: Record<string, string> } }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const fingerprint = input.jobId ? input.conflictOverride?.fingerprints[input.jobId] : undefined;
    const conflictOverride = input.conflictOverride?.reason.trim() && fingerprint ? { reason: input.conflictOverride.reason, fingerprint } : null;
    if (input.approve) await approveJobChange(actor, tx, input.requestId, new Date(), { conflictOverride });
    else await declineJobChange(actor, tx, input.requestId, input.reason);
    return { ok: true, message: input.approve ? "Change approved. People on the detail were alerted." : "Change declined." };
  });
}

/** Copies a detail onto the chosen dates: the detail and its attachments, never the people (each copy starts empty). */
export async function copyDetailAction(input: { jobId: string; dates: string[] }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const r = await copyJob(actor, tx, input.jobId, { kind: "dates", dates: input.dates });
    return { ok: true, value: r.jobs[0]?.id, message: `${plural(r.jobs.length, "copy", "copies")} made in one series, with no one signed up yet.` };
  });
}

export async function repeatDetailAction(input: { jobId: string; recurrence: Recurrence & { end: { count: number } | { until: string } } }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    let r = input.recurrence as Recurrence;
    if ("until" in input.recurrence.end) {
      const until = agencyDateOnly(input.recurrence.end.until, "end");
      if (!until) throw new ValidationError("Choose the date the repeat ends.");
      r = { ...input.recurrence, end: { until } } as Recurrence;
    }
    const made = await createRecurringJobs(actor, tx, input.jobId, r);
    return { ok: true, message: `${plural(made.length, "more detail")} added to the series.` };
  });
}

export async function assignAction(input: { jobPositionId: string; userId: string; overrideReason: string; notify: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await assignPerson(actor, tx, input.jobPositionId, input.userId, { overrideReason: input.overrideReason, notify: input.notify });
    return { ok: true, message: "Assigned." };
  });
}

export async function removeAction(input: { assignmentId: string; comment: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await removePerson(actor, tx, input.assignmentId, input.comment);
    return { ok: true, message: "Removed. The person was told." };
  });
}

export async function noShowAction(input: { assignmentId: string; note: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await markNoShow(actor, tx, input.assignmentId, input.note);
    return { ok: true, message: "Marked as a no-show." };
  });
}

export async function nameIcAction(input: { jobId: string; userId: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await nameIc(actor, tx, input.jobId, input.userId);
    return { ok: true, message: "Incident Commander named." };
  });
}

export async function waiveLateCancelAction(input: { jobId: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const w = await waiveLateCancelPay(actor, tx, input.jobId, input.reason);
    return { ok: true, message: `Late cancellation pay waived for ${plural(w.length, "person", "people")}.` };
  });
}

export async function reviewOpsPlanAction(input: { opsPlanId: string; versionId: string; decision: "agreed" | "denied"; comments: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await reviewOpsPlan(actor, tx, input.opsPlanId, { decision: input.decision, comments: input.comments, versionId: input.versionId });
    return { ok: true, message: input.decision === "agreed" ? "Ops plan agreed." : "Ops plan denied and sent back to the Incident Commander." };
  });
}

export async function reviewNoteAction(input: { noteId: string; decision: "approve" | "deny"; editedBody?: string; comment?: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await reviewDeputyNote(actor, tx, input.noteId, input);
    return { ok: true, message: input.decision === "approve" ? "Note approved. Deputies see it on this vendor's details." : "Note denied. The author was told." };
  });
}

export async function editNoteAction(input: { noteId: string; body: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await editDeputyNote(actor, tx, input.noteId, { body: input.body });
    return { ok: true, message: "Note saved." };
  });
}

export async function retireNoteAction(noteId: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await retireDeputyNote(actor, tx, noteId);
    return { ok: true, message: "Note retired. Deputies no longer see it." };
  });
}

export async function decideFlagAction(input: { requestId: string; approve: boolean; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await decideQualificationRequest(actor, tx, input.requestId, { approve: input.approve, reason: input.reason });
    return { ok: true, message: input.approve ? "Flag granted." : "Request denied." };
  });
}

/** Where an invoice paid on the spot went once approved: sent, queued with the next send, or kept. */
function paidOnSpotMessage(inv: { sentAt: Date | null; readyAt: Date | null }): string {
  if (inv.sentAt) return "Invoice was paid on the spot: closed as paid and sent to the vendor marked paid.";
  if (inv.readyAt) return "Invoice was paid on the spot: closed as paid. The paid invoice goes out with the vendor's next invoice send.";
  return "Invoice was paid on the spot: closed as paid, not sent.";
}

export async function approveInvoiceAction(invoiceId: string, opts: { attachW9?: boolean; send?: boolean } = {}): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const inv = await approveInvoice(actor, tx, invoiceId, new Date(), { attachW9: opts.attachW9 === true, send: opts.send === undefined ? undefined : opts.send === true });
    if (inv.status === "approved_unsent") return { ok: true, message: "Invoice approved, not sent. Send it from the invoice when you are ready." };
    if (inv.status === "paid") return { ok: true, message: paidOnSpotMessage(inv) };
    if (inv.status === "ready_to_send") return { ok: true, message: "Invoice approved. It goes out with the vendor's next invoice send." };
    return { ok: true, message: "Invoice approved and sent to the vendor." };
  });
}

export async function resendInvoiceAction(input: { invoiceId: string; alsoTo: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const { to } = await resendInvoice(actor, tx, input.invoiceId, { alsoTo: input.alsoTo });
    return { ok: true, message: `Invoice resent to ${to.join(", ")}.` };
  });
}

/** "Send now" for an invoice approved without sending. */
export async function sendApprovedInvoiceAction(invoiceId: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const inv = await sendApprovedInvoice(actor, tx, invoiceId);
    if (inv.status === "paid") return { ok: true, message: inv.sentAt ? "Paid invoice sent to the vendor." : "Paid invoice queued. It goes out with the vendor's next invoice send." };
    if (inv.status === "ready_to_send") return { ok: true, message: "Invoice queued. It goes out with the vendor's next invoice send." };
    return { ok: true, message: "Invoice sent to the vendor." };
  });
}

export async function setVendorCurrentYearW9Action(input: { vendorId: string; on: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await updateVendor(actor, tx, input.vendorId, { requiresCurrentYearW9: input.on === true });
    return { ok: true, message: input.on ? "Invoices to this vendor attach a W-9 only when it was signed this year." : "Invoices to this vendor attach any approved W-9." };
  });
}

export async function setVendorEmailApprovedAction(input: { vendorId: string; on: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await updateVendor(actor, tx, input.vendorId, { emailApprovedInvoices: input.on === true });
    return { ok: true, message: input.on ? "Approved invoices are emailed to this vendor." : "Approved invoices are not emailed to this vendor unless you choose to send them." };
  });
}

export async function sendInvoiceBatchAction(input: { vendorId: string; attachW9ForAll: boolean; missingW9: "send" | "hold"; includeWaiting: boolean; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const r = await sendInvoiceBatch(actor, tx, input.vendorId, {
      attachW9ForAll: input.attachW9ForAll === true,
      missingW9: input.missingW9 === "hold" ? "hold" : "send",
      includeWaiting: input.includeWaiting === true,
      reason: input.reason,
    });
    const held = r.held ? ` ${plural(r.held, "invoice stays", "invoices stay")} queued.` : "";
    return { ok: true, message: `${plural(r.sent, "invoice")} sent in one email.${held}` };
  });
}

export async function setVendorSendScheduleAction(input: { vendorId: string; schedule: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const schedule = input.schedule === "" ? null : (input.schedule as SendSchedule);
    await updateVendor(actor, tx, input.vendorId, { invoiceSendSchedule: schedule });
    return { ok: true, message: "Invoice sending saved." };
  });
}

export async function setWaitForAllDeputiesAction(input: { jobId: string; value: "agency" | "on" | "off" }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setWaitForAllDeputies(actor, tx, input.jobId, input.value === "agency" ? null : input.value === "on");
    return { ok: true, message: "Invoice hold saved." };
  });
}

export async function sendBackInvoiceAction(input: { invoiceId: string; comment: string; payeeName: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await sendBackInvoice(actor, tx, input.invoiceId, input.comment);
    return { ok: true, message: `Invoice sent back to ${input.payeeName}.` };
  });
}

/** Start and end are agency date and time ("YYYY-MM-DDTHH:mm"); rate in dollars; minimum in hours. Blank leaves a field as it is. */
export async function editInvoiceAction(input: { invoiceId: string; start: string; end: string; rate: string; minimumHours: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const when = (v: string, label: string) => {
      if (!v) return undefined;
      const [d, t] = v.split("T");
      return onDay(d, t, label);
    };
    const rate = parseDollars(input.rate, "The rate");
    const hours = input.minimumHours.trim();
    if (hours && !/^\d{1,2}(\.\d{1,2})?$/.test(hours)) throw new ValidationError("Enter the minimum in hours, such as 4.");
    await editInvoice(actor, tx, input.invoiceId, {
      startAt: when(input.start, "Start"),
      endAt: when(input.end, "End"),
      rateCents: rate ?? undefined,
      minimumBillableMinutes: hours ? Math.round(Number(hours) * 60) : undefined,
      reason: input.reason,
    });
    return { ok: true, message: "Invoice corrected." };
  });
}

export async function closeInvoiceAction(input: { invoiceId: string; outcome: "paid" | "written_off"; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await coordinatorCloseInvoice(actor, tx, input.invoiceId, input);
    return { ok: true, message: input.outcome === "paid" ? "Closed as paid." : "Written off." };
  });
}

export async function issueWaitingOnAction(input: { issueId: string; party: Party; note: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setIssueWaitingOn(actor, tx, input.issueId, input.party, input.note);
    return { ok: true, message: `Now waiting on the ${input.party}.` };
  });
}

export async function issueNoteAction(input: { issueId: string; note: string; internal: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await addIssueNote(actor, tx, input.issueId, input.note, input.internal ? "internal" : "deputy");
    return { ok: true, message: "Note added." };
  });
}

const CLOSED_MESSAGE: Partial<Record<IssueOutcome, string>> = { paid: "Closed as paid.", written_off: "Written off." };

export async function closeIssueAction(input: { issueId: string; outcome: IssueOutcome; note: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await closeIssue(actor, tx, input.issueId, input.outcome, input.note);
    return { ok: true, message: CLOSED_MESSAGE[input.outcome] ?? "Issue resolved. The invoice continues." };
  });
}

export async function liftLockAction(input: { userId: string; days: number; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (!Number.isInteger(input.days) || input.days < 1 || input.days > 30) throw new ValidationError("Choose 1 to 30 days.");
    // Through the last chosen agency day: "1 day" ends at midnight tonight.
    const until = agencyDateOnly(addDays(agencyDayKey(new Date()), input.days), "start")!;
    await overrideBillingLock(actor, tx, input.userId, { reason: input.reason, until });
    return { ok: true, message: `Lock lifted until midnight at the end of ${keyDay(addDays(agencyDayKey(new Date()), input.days - 1))}. The person was told.` };
  });
}

type VendorWire = { name: string; contactName: string; phone: string; billingEmails: string; rate: string; notes: string };

function vendorInput(w: VendorWire): VendorInput {
  return {
    name: w.name,
    typeId: null,
    contactName: w.contactName || null,
    phone: w.phone || null,
    billingEmails: w.billingEmails.split(/[,\s]+/).filter(Boolean),
    defaultRateCents: parseDollars(w.rate, "The default rate"),
    notes: w.notes || null,
  };
}

export async function createVendorAction(input: VendorWire): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const v = await createVendor(actor, tx, vendorInput(input));
    return { ok: true, value: v.id, message: "Vendor added." };
  });
}

export async function updateVendorAction(input: VendorWire & { vendorId: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const patch: Partial<VendorInput> = vendorInput(input);
    // This form does not edit the vendor type.
    delete patch.typeId;
    await updateVendor(actor, tx, input.vendorId, patch);
    return { ok: true, message: "Vendor saved." };
  });
}

export async function paymentHoldAction(input: { vendorId: string; place: boolean; reason: string; outcome?: "fix_coming" | "handled" }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (input.place) {
      await placePaymentHold(actor, tx, input.vendorId, input.reason);
      return { ok: true, message: "Payment hold placed. Future details are locked and people on them were alerted." };
    }
    await resolvePaymentHold(actor, tx, input.vendorId, { outcome: input.outcome ?? "handled", note: input.reason });
    return { ok: true, message: "Hold resolved. Details unlock and people on them were alerted." };
  });
}

export async function addLocationAction(input: { vendorId: string; name: string; address: string; pin?: Exclude<LocationInput["pin"], undefined> }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await addLocation(actor, tx, input.vendorId, { name: input.name, address: input.address || null, pin: input.pin });
    return { ok: true, message: "Location added." };
  });
}

export async function locationActiveAction(input: { locationId: string; active: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setLocationActive(actor, tx, input.locationId, input.active);
    return { ok: true, message: input.active ? "Location reactivated." : "Location deactivated. Its history stays." };
  });
}

export async function addDocumentLinkAction(input: { vendorId: string; kind: "contract" | "other"; label: string; url: string; signedOn: string; expiresOn: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await addVendorDocument(actor, tx, input.vendorId, {
      kind: input.kind,
      label: input.label,
      url: input.url,
      signedOn: agencyDateOnly(input.signedOn) ?? undefined,
      expiresOn: agencyDateOnly(input.expiresOn) ?? undefined,
    });
    return { ok: true, message: "Link added." };
  });
}

export async function restrictAction(input: { vendorId: string; userId: string; reason: string; removeFromFutureDetails: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await restrictFromVendor(actor, tx, input.userId, input.vendorId, input);
    return { ok: true, message: "Deputy restricted from this vendor." };
  });
}

export async function liftRestrictionAction(restrictionId: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await liftVendorRestriction(actor, tx, restrictionId);
    return { ok: true, message: "Restriction lifted." };
  });
}

export async function addLoginAction(input: { vendorId: string; name: string; email: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await createVendorLogin(actor, tx, input.vendorId, input);
    return { ok: true, message: "Login added. An invitation was emailed." };
  });
}

export type ReportWire = Omit<ReportSpec, "from" | "to"> & { from: string; to: string };

function reportSpec(w: ReportWire): ReportSpec {
  const from = agencyDateOnly(w.from, "start");
  const to = agencyDateOnly(w.to, "end");
  if (!from || !to) throw new ValidationError("Choose the period to report on.");
  return { ...w, from, to };
}

/** Runs a report; the result comes back as JSON. */
export async function runReportAction(spec: ReportWire): Promise<ActionResult> {
  return act(async (actor, tx) => ({ ok: true, value: JSON.stringify(await runReport(actor, tx, reportSpec(spec))) }));
}

export async function saveReportAction(input: { name: string; spec: ReportWire }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const row = await saveReport(actor, tx, input.name, reportSpec(input.spec));
    return { ok: true, value: row.id, message: "Report saved." };
  });
}

export async function deleteReportAction(id: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await deleteSavedReport(actor, tx, id);
    return { ok: true, message: "Report deleted." };
  });
}

/** Quick and bulk edit as sent by the screen: only the fields being changed are present. */
export type EditWire = {
  rate?: string;
  startTime?: string;
  endTime?: string;
  positions?: Array<{ positionTypeId: string; count: number }>;
  description?: string;
  rateOverrideReason?: string;
  /** Sent only after the coordinator confirmed saving past the listed deputy conflicts; fingerprints per detail. */
  conflictOverride?: { reason: string; fingerprints: Record<string, string> };
};

function editPatch(w: EditWire): EditPatch {
  const patch: EditPatch = {};
  if (w.rate !== undefined) {
    const cents = parseDollars(w.rate, "The rate");
    if (cents === null) throw new ValidationError("Enter the new rate, such as 70 or 72.50.");
    patch.rateCents = cents;
  }
  if (w.startTime) patch.startTime = w.startTime;
  if (w.endTime) patch.endTime = w.endTime;
  if (w.positions) patch.positions = w.positions.map((p) => ({ positionTypeId: p.positionTypeId, count: Number(p.count) }));
  if (w.description !== undefined) patch.description = w.description;
  if (w.rateOverrideReason?.trim()) patch.rateOverrideReason = w.rateOverrideReason;
  if (w.conflictOverride?.reason.trim()) patch.conflictOverride = { reason: w.conflictOverride.reason, fingerprints: { ...w.conflictOverride.fingerprints } };
  return patch;
}

/** Before and after for each selected detail, as JSON in `value`; nothing is saved. */
export async function previewEditAction(input: { jobIds: string[]; edit: EditWire }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const rows = await previewEdit(actor, tx, input.jobIds, editPatch(input.edit));
    return { ok: true, value: JSON.stringify(rows) };
  });
}

/** Saves a bulk edit on every selected detail, or on none. */
export async function applyEditAction(input: { jobIds: string[]; edit: EditWire }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const rows = await applyEdit(actor, tx, input.jobIds, editPatch(input.edit));
    return { ok: true, message: rows.length === 1 ? "1 detail saved." : `${rows.length} details saved.` };
  });
}

/** Quick edit from the detail page: this detail, or this and the later details of its series. */
export async function quickEditAction(input: { jobId: string; scope: "one" | "series"; edit: EditWire }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const ids = await seriesIds(tx, input.jobId, input.scope === "series" ? "series" : "one");
    const rows = await applyEdit(actor, tx, ids, editPatch(input.edit));
    return { ok: true, message: rows.length === 1 ? "Saved." : `Saved on ${rows.length} details.` };
  });
}
