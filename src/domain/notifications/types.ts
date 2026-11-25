/** Every alert type. Spec section 14's rows, plus the types already in use and the Task 26 additions. */
export const NOTIFICATION_TYPES = [
  // Spec section 14
  "spot.offered",
  "spot.opened_first_come",
  "job.watch_opened",
  "job.watch_released",
  "job.changed",
  "job.canceled",
  "job.locked",
  "job.unlocked",
  "assignment.assigned",
  "assignment.removed",
  "billing.ready",
  "billing.unbilled_reminder",
  "invoice.edited",
  "invoice.returned",
  "vendor.request_submitted",
  "vendor.request_edited",
  "invoice.review_waiting",
  "payment.issue_opened",
  "ops_plan.due",
  "ops_plan.overdue",
  "ops_plan.submitted",
  "ops_plan.resubmitted",
  "ops_plan.agreed",
  "ops_plan.denied",
  "message.received",
  // Already in use
  "spot.offer_ended",
  "signup.short_confirmed",
  "signup.short_declined",
  "invoice.email_failed",
  "invoice.vendor_paid",
  "settings.email_incomplete",
  "access_review.reminder",
  // Task 26 additions
  "user.suspended",
  "job.safety_changed",
  // Task 27 addition
  "vendor.contract_expiring",
  // Task 29 additions
  "vendor.request_decided",
  "job.late_cancel_waived",
  // Task 30 addition
  "billing.lock_overridden",
  // Task 31 additions
  "payment_issue.opened",
  "payment_issue.waiting_on",
  "payment_issue.closed",
  "payment_issue.overdue",
  // Task 32 additions
  "ops_plan.due_soon",
  "ops_plan.review_waiting",
  "ops_plan.no_reviewers",
  // Task 33 additions
  "deputyNote.submitted",
  "deputyNote.approved",
  "deputyNote.denied",
  // Task 39b addition
  "invoice.batch_due",
  // Task 40c addition
  "job.reactivated",
  // Task 43 addition
  "settings.email_replaced",
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

const BOTH = { email: true, push: true } as const;

/**
 * Channels used when a person has not chosen for a type. The inbox row is always written. Types that need
 * action or change the person's own detail default to email and push; purely informational ones to inbox only.
 */
export const DEFAULT_CHANNELS: Record<NotificationType, { email: boolean; push: boolean }> = Object.fromEntries(
  NOTIFICATION_TYPES.map((t) => [t, BOTH]),
) as Record<NotificationType, { email: boolean; push: boolean }>;
DEFAULT_CHANNELS["spot.offer_ended"] = { email: false, push: false };
// Owner decision: a suspension notice is in-app only (the catalog locks it there).
DEFAULT_CHANNELS["user.suspended"] = { email: false, push: false };
// Vendor decisions go to vendor logins by email only.
DEFAULT_CHANNELS["vendor.request_decided"] = { email: true, push: false };
// Spec 14: messages alert by push; email is opt-in.
DEFAULT_CHANNELS["message.received"] = { email: false, push: true };
// Deputy notes: coordinators are told by inbox and email; the author by inbox and push.
DEFAULT_CHANNELS["deputyNote.submitted"] = { email: true, push: false };
DEFAULT_CHANNELS["deputyNote.approved"] = { email: false, push: true };
DEFAULT_CHANNELS["deputyNote.denied"] = { email: false, push: true };

export function isNotificationType(value: string): value is NotificationType {
  return (NOTIFICATION_TYPES as readonly string[]).includes(value);
}

export type NotificationEvent = {
  type: NotificationType;
  recipients: string[];
  title: string;
  body: string;
  /** App path, for example `/jobs/<id>`. */
  link: string;
  /** Coordinator-sent: ignores preferences and quiet hours. */
  mandatory?: boolean;
};
