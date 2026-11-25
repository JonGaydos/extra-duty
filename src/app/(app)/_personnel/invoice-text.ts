import type { MyInvoice } from "@/domain/personnel/views";
import { dateLabel, monthDay } from "./format";

const DAY_MS = 86_400_000;

/** What is going on with an invoice, in one or two sentences. */
export function invoiceSentence(i: MyInvoice, now: Date): string[] {
  if (i.status === "pending_review") return ["With a coordinator for review before it goes to the vendor."];
  if (i.status === "ready_to_send") return [i.queuedSend ?? "Approved and waiting for the next invoice send to the vendor."];
  if (i.status === "approved_unsent") return ["Approved, not sent to the vendor. If you were paid, mark it received to close it."];
  if (i.status === "returned") return ["Sent back to you. Bill it again from To bill."];
  if (i.status === "paid") return [`Paid${i.deputyPaidAt ? `, received ${dateLabel(i.deputyPaidAt)}` : ""}.`];
  if (i.status === "written_off") return [`Written off.${i.closedReason ? ` ${i.closedReason}` : ""}`];
  const out: string[] = [];
  const elapsed = (since: Date | null) => (since ? Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS)) : 0);
  if (i.openIssue) out.push("You reported non-payment. The extra duty office is working it. Nothing locks while it is with them.");
  else if (i.vendorPaidAt) {
    out.push(`Vendor reports paid on ${monthDay(i.vendorPaidAt)}${i.vendorMethod ? ` by ${i.vendorMethod}` : ""}${i.vendorReference ? `, #${i.vendorReference}` : ""}.`);
    if (i.dueAt && i.responseDays) out.push(`${Math.min(i.responseDays, elapsed(new Date(i.dueAt.getTime() - i.responseDays * DAY_MS)))} of ${i.responseDays} days to confirm. Confirm by ${monthDay(i.dueAt)}.`);
  } else {
    out.push(`Sent ${i.sentAt ? monthDay(i.sentAt) : ""}. Waiting for the vendor to pay.`);
    if (i.dueAt && i.turn === "vendor") out.push(i.canReport ? "The vendor's time is up. You can report non-payment." : `You can report non-payment after ${monthDay(i.dueAt)}.`);
  }
  return out;
}

