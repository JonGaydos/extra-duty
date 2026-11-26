import type { MyInvoice } from "@/domain/personnel/views";
import { dateLabel, monthDay } from "./format";

const DAY_MS = 86_400_000;

/** The one sentence for an invoice that is not out with the vendor, or null when it is. */
function settledSentence(i: MyInvoice): string | null {
  if (i.status === "pending_review") return "With a coordinator for review before it goes to the vendor.";
  if (i.status === "ready_to_send") return i.queuedSend ?? "Approved and waiting for the next invoice send to the vendor.";
  if (i.status === "approved_unsent") return "Approved, not sent to the vendor. If you were paid, mark it received to close it.";
  if (i.status === "returned") return "Sent back to you. Bill it again from To bill.";
  if (i.status === "paid") {
    const received = i.deputyPaidAt ? `, received ${dateLabel(i.deputyPaidAt)}` : "";
    return `Paid${received}.`;
  }
  if (i.status === "written_off") {
    const reason = i.closedReason ? ` ${i.closedReason}` : "";
    return `Written off.${reason}`;
  }
  return null;
}

/** Whole days from `since` to `now`, never below 0 (0 with no start). */
const daysSince = (since: Date | null, now: Date) => (since ? Math.max(0, Math.floor((now.getTime() - since.getTime()) / DAY_MS)) : 0);

/** The vendor reported paying: when and how, and how long the person has to confirm. */
function vendorPaidSentences(i: MyInvoice, vendorPaidAt: Date, now: Date): string[] {
  const method = i.vendorMethod ? ` by ${i.vendorMethod}` : "";
  const reference = i.vendorReference ? `, #${i.vendorReference}` : "";
  const out = [`Vendor reports paid on ${monthDay(vendorPaidAt)}${method}${reference}.`];
  if (i.dueAt && i.responseDays) out.push(`${Math.min(i.responseDays, daysSince(new Date(i.dueAt.getTime() - i.responseDays * DAY_MS), now))} of ${i.responseDays} days to confirm. Confirm by ${monthDay(i.dueAt)}.`);
  return out;
}

/** Sent and not paid yet: when it went, and when non-payment can be reported. */
function waitingSentences(i: MyInvoice): string[] {
  const out = [`Sent ${i.sentAt ? monthDay(i.sentAt) : ""}. Waiting for the vendor to pay.`];
  if (i.dueAt && i.turn === "vendor") out.push(i.canReport ? "The vendor's time is up. You can report non-payment." : `You can report non-payment after ${monthDay(i.dueAt)}.`);
  return out;
}

/** What is going on with an invoice, in one or two sentences. */
export function invoiceSentence(i: MyInvoice, now: Date): string[] {
  const settled = settledSentence(i);
  if (settled !== null) return [settled];
  if (i.openIssue) return ["You reported non-payment. The extra duty office is working it. Nothing locks while it is with them."];
  if (i.vendorPaidAt) return vendorPaidSentences(i, i.vendorPaidAt, now);
  return waitingSentences(i);
}

