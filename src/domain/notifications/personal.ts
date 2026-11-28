import type { Actor } from "../actor";
import { isVendorManager } from "../auth/policy";
import type { NotificationType } from "./types";

export type PersonalAlertType = { type: NotificationType; label: string };

/** The alerts everyone who works details can get, as their own Alerts list names them. */
const WORK_ALERTS: PersonalAlertType[] = [
  { type: "spot.offered", label: "A backup spot is offered to you" },
  { type: "spot.opened_first_come", label: "A spot opens for anyone" },
  { type: "job.watch_opened", label: "A detail you watch opens" },
  { type: "job.watch_released", label: "A detail you watch is released" },
  { type: "job.reminder", label: "Reminders before a detail you are on starts" },
  { type: "job.changed", label: "A detail you are on changes" },
  { type: "job.canceled", label: "A detail you are on is canceled" },
  { type: "job.reactivated", label: "A canceled detail you were on is back on" },
  { type: "job.safety_changed", label: "Officer safety information changes" },
  { type: "assignment.assigned", label: "A coordinator assigns you" },
  { type: "assignment.removed", label: "A coordinator removes you" },
  { type: "signup.short_confirmed", label: "A shorter shift is confirmed" },
  { type: "signup.short_declined", label: "A shorter shift is declined" },
  { type: "billing.ready", label: "A detail is ready to bill" },
  { type: "billing.unbilled_reminder", label: "Reminders about unbilled details" },
  { type: "invoice.returned", label: "An invoice is sent back to you" },
  { type: "invoice.vendor_paid", label: "A vendor reports paying you" },
  { type: "payment_issue.waiting_on", label: "A payment issue needs you" },
  { type: "ops_plan.due", label: "An ops plan is due" },
  { type: "message.received", label: "You get a message" },
];

/** Vendor request alerts: coordinators, admins and a vendor's managers receive them (owner decision 2026-11-27). */
const VENDOR_REQUEST_ALERTS: PersonalAlertType[] = [
  { type: "vendor.request_submitted", label: "A vendor sends a detail request" },
  { type: "vendor.request_edited", label: "A vendor changes a request or detail" },
];

/** The alert types a person can switch email and push for on their own Alerts list: the ones they can receive. */
export function personalAlertTypes(actor: Actor): PersonalAlertType[] {
  const getsVendorRequests = actor.role === "coordinator" || actor.role === "admin" || isVendorManager(actor);
  return getsVendorRequests ? [...WORK_ALERTS, ...VENDOR_REQUEST_ALERTS] : WORK_ALERTS;
}
