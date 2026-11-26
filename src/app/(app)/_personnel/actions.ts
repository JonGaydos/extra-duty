"use server";

import { withTx } from "@/ui/shell/request";
import { cancelSignup, claimSpot } from "@/domain/assignments/cancel";
import { joinBackup, signUp, unwatchJob, watchJob } from "@/domain/assignments/signup";
import { billAssignment } from "@/domain/billing/bill";
import { markPaid } from "@/domain/billing/payments";
import { submitDeputyNote } from "@/domain/deputy-notes/deputy-notes";
import { ValidationError } from "@/domain/errors";
import { hideMessages, markRead, sendMessage, type Audience } from "@/domain/messages/messages";
import { markAllAlertsRead } from "@/domain/notifications/inbox";
import { markRead as markAlertsRead, setPreference, setQuietHours, subscribePush } from "@/domain/notifications/prefs";
import { reportNonPayment } from "@/domain/payment-issues/issues";
import { setCalendarFeed, syncCalendarNow } from "@/domain/planning/calendar";
import { revokeCalendarToken, rotateCalendarToken } from "@/domain/planning/ics-feed";
import { hideVendor, setEarningsGoal, unhideVendor } from "@/domain/planning/preferences";
import { addScheduleException, removeScheduleException, setWorkSchedule, type ExceptionInput, type WorkScheduleInput } from "@/domain/planning/schedule";
import { agencyDateOnly } from "@/domain/time/agency-time";
import { updateOwnContact } from "@/domain/users/contact";
import { billMessage } from "./bill-message";
import { fromLocalInput } from "./format";
import { act, actOutsideTx, type ActionResult } from "./result";

/** Server actions for the personnel screens: each one checks the person, calls one service and reports back. */

const isoDate = (v: unknown, label: string): Date => {
  const d = typeof v === "string" ? new Date(v) : new Date(Number.NaN);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`${label} is not a valid time.`);
  return d;
};

export async function signUpAction(input: { jobId: string; jobPositionId: string; warningVersion: number; plannedStartAt?: string; plannedEndAt?: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const planned =
      input.plannedStartAt && input.plannedEndAt
        ? { plannedStartAt: isoDate(input.plannedStartAt, "Start"), plannedEndAt: isoDate(input.plannedEndAt, "End") }
        : {};
    const row = await signUp(actor, tx, input.jobPositionId, { warningVersion: input.warningVersion, jobId: input.jobId, ...planned });
    return {
      ok: true,
      message: row.status === "pending_short" ? "Request sent. A shorter shift stays pending until the shorter-shift window opens." : "You are signed up.",
    };
  });
}

export async function joinBackupAction(input: { jobId: string; jobPositionId: string; warningVersion: number }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const row = await joinBackup(actor, tx, input.jobPositionId, { warningVersion: input.warningVersion, jobId: input.jobId });
    return { ok: true, message: `You are backup #${row.backupPosition}.` };
  });
}

/** A backup takes the spot offered to them (or any free spot no offer holds). */
export async function claimSpotAction(input: { jobId: string; jobPositionId: string; warningVersion: number }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await claimSpot(actor, tx, input.jobPositionId, { warningVersion: input.warningVersion, jobId: input.jobId });
    return { ok: true, message: "You are signed up." };
  });
}

export async function cancelSignupAction(input: { assignmentId: string; reason: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await cancelSignup(actor, tx, input.assignmentId, input.reason);
    return { ok: true, message: "Your sign-up is canceled." };
  });
}

export async function watchAction(input: { jobId: string; on: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (input.on) await watchJob(actor, tx, input.jobId);
    else await unwatchJob(actor, tx, input.jobId);
    return { ok: true, message: input.on ? "We will alert you if a spot opens." : "Alert turned off." };
  });
}

export async function hideVendorAction(vendorId: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await hideVendor(actor, tx, vendorId);
    return { ok: true, message: "Vendor hidden from your lists. Show it again from Profile." };
  });
}

export async function unhideVendorAction(vendorId: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await unhideVendor(actor, tx, vendorId);
    return { ok: true, message: "Vendor shown in your lists again." };
  });
}

export async function addDeputyNoteAction(input: { jobId: string; body: string; scope: "vendor" | "location" }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await submitDeputyNote(actor, tx, input);
    return { ok: true, message: "Thanks. A coordinator reviews notes before other deputies see them." };
  });
}

export async function billAction(input: {
  assignmentId: string;
  start: string;
  end: string;
  reason: string;
  attachW9: boolean;
  paidOnSpot: { methodId: string; reference: string } | null;
}): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const startAt = fromLocalInput(input.start);
    const endAt = fromLocalInput(input.end);
    if (!startAt || !endAt) throw new ValidationError("Enter the start and end you worked.");
    const { delivery, invoice } = await billAssignment(actor, tx, input.assignmentId, {
      startAt,
      endAt,
      changeReason: input.reason,
      attachW9: input.attachW9,
      paidOnSpot: input.paidOnSpot ?? undefined,
    });
    return { ok: true, message: billMessage(delivery, invoice.status) };
  });
}

export async function markReceivedAction(input: { invoiceId: string; paidDate: string; methodId: string; reference: string; note: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const paidAt = agencyDateOnly(input.paidDate);
    if (!paidAt) throw new ValidationError("Enter the date you received payment.");
    if (!input.methodId) throw new ValidationError("Choose how you were paid.");
    await markPaid(actor, tx, input.invoiceId, { paidAt, paymentMethodId: input.methodId, reference: input.reference, note: input.note });
    return { ok: true, message: "Payment recorded." };
  });
}

export async function reportNonPaymentAction(input: { invoiceId: string; note: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await reportNonPayment(actor, tx, input.invoiceId, input.note);
    return { ok: true, message: "Reported. The extra duty office takes it from here." };
  });
}

export async function saveContactAction(input: { phone: string; mailingAddress: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await updateOwnContact(actor, tx, input);
    return { ok: true, message: "Contact details saved." };
  });
}

export async function saveScheduleAction(input: WorkScheduleInput | null): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setWorkSchedule(actor, tx, input);
    return { ok: true, message: input ? "Schedule saved." : "Schedule turned off." };
  });
}

export async function addExceptionAction(input: ExceptionInput): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await addScheduleException(actor, tx, input);
    return { ok: true, message: "Change added." };
  });
}

export async function removeExceptionAction(id: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await removeScheduleException(actor, tx, id);
    return { ok: true, message: "Change removed." };
  });
}

/** Dollars as typed ("800" or "800.50"); blank clears the goal. */
export async function saveGoalAction(dollars: string): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const t = dollars.replace(/[$,\s]/g, "");
    if (t === "") {
      await setEarningsGoal(actor, tx, null);
      return { ok: true, message: "Goal cleared." };
    }
    if (!/^\d{1,7}(\.\d{1,2})?$/.test(t)) throw new ValidationError("Enter the goal in dollars, such as 800.");
    const [whole, cents = ""] = t.split(".");
    await setEarningsGoal(actor, tx, Number(whole) * 100 + Number(cents.padEnd(2, "0")));
    return { ok: true, message: "Goal saved." };
  });
}

export async function setCalendarLinkAction(url: string | null): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setCalendarFeed(actor, tx, url?.trim() ? url.trim() : null);
    return { ok: true, message: url ? "Calendar link saved. Choose Sync now to import it." : "Calendar link removed." };
  });
}

export async function syncCalendarAction(): Promise<ActionResult> {
  return actOutsideTx(async (actor) => {
    const r = await syncCalendarNow(actor, withTx);
    return r.ok ? { ok: true, message: "Calendar synced." } : { ok: false, error: r.lastError };
  });
}

export async function savePreferenceAction(input: { type: string; email: boolean; push: boolean }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setPreference(actor, tx, input.type, { email: input.email, push: input.push });
    return { ok: true, message: "Alert choice saved." };
  });
}

export async function saveQuietHoursAction(window: { start: string; end: string } | null): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await setQuietHours(actor, tx, window);
    return { ok: true, message: window ? "Quiet hours saved." : "Quiet hours off." };
  });
}

export async function subscribePushAction(subscription: PushSubscriptionJSON): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await subscribePush(actor, tx, subscription);
    return { ok: true, message: "Push alerts are on for this device." };
  });
}

/** Makes a new feed link and returns its token once; the page builds the URL. */
export async function rotateFeedAction(): Promise<ActionResult> {
  return act(async (actor, tx) => ({ ok: true, message: "New calendar link made. Any old link stopped working.", value: await rotateCalendarToken(actor, tx) }));
}

export async function revokeFeedAction(): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await revokeCalendarToken(actor, tx);
    return { ok: true, message: "Calendar link turned off." };
  });
}

export async function sendMessageAction(input: { audiences: Audience[]; subject: string; body: string; jobId?: string; replyToMessageId?: string }): Promise<ActionResult> {
  return act(async (actor, tx) => {
    const m = await sendMessage(actor, tx, input);
    return { ok: true, message: `Sent to ${m.recipientCount} ${m.recipientCount === 1 ? "person" : "people"}.`, value: m.id };
  });
}

export async function markMessagesAction(ids: string[], read: boolean): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await markRead(actor, tx, ids, read);
    return { ok: true, message: read ? "Marked read." : "Marked unread." };
  });
}

export async function hideMessagesAction(ids: string[]): Promise<ActionResult> {
  return act(async (actor, tx) => {
    await hideMessages(actor, tx, ids);
    return { ok: true, message: ids.length === 1 ? "Message deleted." : "Messages deleted." };
  });
}

/** Marks the given alerts read, or every unread alert with "all". */
export async function markAlertsReadAction(ids: string[] | "all"): Promise<ActionResult> {
  return act(async (actor, tx) => {
    if (ids === "all") await markAllAlertsRead(actor, tx);
    else await markAlertsRead(actor, tx, ids);
    return { ok: true, message: ids === "all" ? "All alerts marked read." : "Marked read." };
  });
}
