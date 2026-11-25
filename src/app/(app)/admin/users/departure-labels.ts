/** Plain words for the departure checklist and the departed person's page (safe for client components). */

export const UNPAID_STATUS_LABEL: Record<string, string> = {
  pending_review: "Waiting for review",
  ready_to_send: "Approved, queued to send",
  approved_unsent: "Approved, not sent",
  sent: "Sent, not paid",
};

export const SIGNUP_STATUS_LABEL: Record<string, string> = {
  signed_up: "Signed up",
  backup: "Backup",
  pending_short: "Shorter shift, pending",
};
