import type { Role } from "@/domain/actor";
import type { NotePresetContext } from "@/domain/jobs/job-types";

export const ROLE_LABEL: Record<Role, string> = { admin: "Admin", coordinator: "Coordinator", personnel: "Personnel", vendor: "Vendor" };

/** Where each note preset is offered. */
export const PRESET_CONTEXT_LABEL: Record<NotePresetContext, string> = {
  vendor_paid: "Vendor marks an invoice paid",
  deputy_paid: "Deputy confirms payment",
  report_nonpayment: "Deputy reports nonpayment",
  issue_note: "Note on a payment issue",
  waiting_on: "Waiting on someone",
  send_back: "Coordinator sends an invoice back",
};

export const DECISION_LABEL = { keep: "Keep", change: "Needs change", deactivate: "Turn off" } as const;
