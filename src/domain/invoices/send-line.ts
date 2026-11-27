import type { AgencySettings } from "@/domain/settings/settings";
import { agencyDayKey } from "@/domain/time/agency-time";
import { queuedSendOf } from "./batch";
import type { Invoice } from "./invoices";
import { effectiveSchedule, nextSendDay, sendDayLabel, sendName, type SendSchedule } from "./send-schedule";

/** What the staff send line reads from an invoice and its vendor. */
export type SendLineInvoice = Pick<Invoice, "status" | "sentAt" | "readyAt" | "paidSendQueued"> & {
  /** It went in a batch email. */
  batched: boolean;
  /** The payee's billing sent it (no review); otherwise a coordinator's approval did. */
  sentByPayee: boolean;
  vendorName: string;
  /** The vendor's own schedule, or null for the agency's. */
  vendorSchedule: SendSchedule | null;
  /** The vendor's "Email approved invoices" setting. */
  sendByDefault: boolean;
};

type Settings = Pick<AgencySettings, "invoiceReviewMode" | "invoiceSendSchedule" | "invoiceSendDayOfWeek" | "invoiceSendStartDate" | "invoiceSendDayOfMonth">;

const REVIEW_REASON: Record<AgencySettings["invoiceReviewMode"], string> = {
  all: " (agency reviews every invoice)",
  changed_hours_only: " (the billed hours were changed)",
  immediate: "",
};

const day = (at: Date) => sendDayLabel(agencyDayKey(at));

/**
 * One plain line, for staff only, on how and when this invoice goes or went to the vendor, from the review setting,
 * the vendor's schedule (or the agency's), the vendor's email setting and the invoice's state.
 */
export function sendLine(inv: SendLineInvoice, s: Settings, now: Date): string {
  const schedule = effectiveSchedule(inv.vendorSchedule, s);
  const ofAgency = inv.vendorSchedule ? "" : " (agency default)";
  const queued = queuedSendOf(inv, inv.vendorSchedule, s, now);
  switch (inv.status) {
    case "pending_review":
      return `Waiting for review${REVIEW_REASON[s.invoiceReviewMode]}`;
    case "returned":
      return "Sent back to the deputy: it goes again when they bill it";
    case "approved_unsent": {
      const noEmail = inv.sendByDefault ? "" : " (" + inv.vendorName + " does not get approved invoices by email)";
      return `Approved, not sent: send it from here when ready${noEmail}`;
    }
    case "ready_to_send":
      return queued ? `Waiting for ${sendName(queued.schedule)} on ${sendDayLabel(queued.day)}${ofAgency}` : "Waiting to send";
    default:
      break;
  }
  if (queued) return `Paid; goes marked Paid with ${sendName(queued.schedule)} on ${sendDayLabel(queued.day)}${ofAgency}`;
  if (!inv.sentAt) return inv.status === "written_off" ? "Written off without being sent to the vendor" : "Closed as paid without being sent to the vendor";
  if (inv.batched && schedule !== "immediate") return `Sent with ${sendName(schedule)} on ${day(inv.sentAt)}`;
  if (inv.batched) return `Sent in a batch on ${day(inv.sentAt)}`;
  const immediate = schedule === "immediate" ? ` (${inv.vendorName} sends immediately)` : "";
  return inv.sentByPayee ? `Sent right away when billed${immediate}` : `Sent when approved on ${day(inv.sentAt)}${immediate}`;
}

/** On the approve step: where the invoice goes once approved and sent. */
export function approveLine(inv: Pick<SendLineInvoice, "vendorName" | "vendorSchedule">, s: Settings, now: Date): string {
  const schedule = effectiveSchedule(inv.vendorSchedule, s);
  if (schedule === "immediate") return `Approve and send: goes to ${inv.vendorName} now.`;
  return `Approve for the next send: ${sendName(schedule)} on ${sendDayLabel(nextSendDay(schedule, s, agencyDayKey(now)))}.`;
}
