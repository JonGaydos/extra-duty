/** What each invoice timeline event says, for staff. The payee's own page swaps in second-person wording. */
export const INVOICE_EVENT: Record<string, string> = {
  sent: "Invoice sent",
  ready_to_send: "Approved, queued for the next send",
  approved_unsent: "Approved, not sent to the vendor",
  send_failed: "Batch email failed, back in the queue",
  send_failed_kept: "Batch email failed, kept as sent (payment recorded)",
  revised: "Revised invoice sent",
  resent: "Invoice resent",
  rebilled: "Billed again",
  edited: "Edited",
  returned: "Sent back to the deputy",
  responsibility: "Turn changed",
  vendor_paid: "Vendor reports paid",
  deputy_paid: "Deputy confirmed payment",
  closed_paid: "Closed as paid",
  closed_written_off: "Written off",
  issue_opened: "Reported non-payment",
  issue_note: "Note",
  issue_waiting_on: "Now waiting on",
  issue_closed: "Payment issue closed",
};

export const PAYEE_INVOICE_EVENT: Record<string, string> = {
  ...INVOICE_EVENT,
  edited: "Edited by a coordinator",
  returned: "Sent back to you",
  deputy_paid: "Payment received",
  issue_waiting_on: "Waiting on changed",
};

export const eventLabel = (event: string, map: Record<string, string> = INVOICE_EVENT) => map[event] ?? event.replace(/_/g, " ");
