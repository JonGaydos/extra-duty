import type { Tx } from "@/db/client";
import type { Actor } from "../actor";
import { myInvoices, toBill, type MyInvoice } from "../personnel/views";
import { realBillingLockReader } from "./lock";

/**
 * The action banner on Home for billing (owner decision 2026-11-27): worked details not billed yet and invoices that
 * wait on the person (a payment the vendor reported, to confirm, or an invoice sent back to fix). It applies to everyone
 * who bills, staff included, cannot be dismissed and goes away once nothing needs action.
 */

export type BillingBanner = {
  tone: "warning" | "danger";
  title: string;
  detail: string;
  action: { href: string; label: string };
};

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** An invoice that waits on the person: sent and on their turn (a vendor-reported payment to confirm), or sent back. */
export function needsAttention(i: Pick<MyInvoice, "status" | "turn" | "deputyPaidAt">): boolean {
  if (i.status === "returned") return true;
  return i.status === "sent" && i.turn === "deputy" && i.deputyPaidAt === null;
}

/** The banner for these counts, or null when nothing needs action. `locked` is the billing lock already in force. */
export function billingBanner(c: { unbilled: number; attention: number; locked: boolean }): BillingBanner | null {
  if (c.unbilled === 0 && c.attention === 0) return null;
  const parts = [
    c.unbilled > 0 ? `You have ${plural(c.unbilled, "worked detail", "worked details")} to bill.` : null,
    c.attention > 0 ? `${plural(c.attention, "invoice needs", "invoices need")} your attention.` : null,
  ].filter(Boolean);
  let detail: string;
  if (c.locked) detail = c.unbilled > 0 ? "Sign-ups are locked until you bill these." : "Sign-ups are locked until you confirm these payments.";
  else if (c.unbilled > 0) detail = "Billing them keeps your sign-ups open.";
  else detail = "Confirm a payment the vendor reported, or fix an invoice sent back to you.";
  const href = c.unbilled > 0 ? "/billing?tab=bill" : "/billing?tab=waiting&needs=1";
  return { tone: c.locked ? "danger" : "warning", title: parts.join(" "), detail, action: { href, label: "Go to billing" } };
}

/** The person's own counts and lock, for Home. */
export async function loadBillingBanner(actor: Actor, tx: Tx, now: Date = new Date()): Promise<BillingBanner | null> {
  if (actor.role === "vendor") return null;
  const bill = await toBill(actor, tx, now);
  const billed = new Set(bill.map((b) => b.jobId));
  // A returned invoice puts its detail back on To bill; it counts once, as a detail to bill.
  const attention = (await myInvoices(actor, tx, now)).filter((i) => needsAttention(i) && !(i.status === "returned" && billed.has(i.jobId))).length;
  const lock = await realBillingLockReader(tx, actor.userId, now);
  return billingBanner({ unbilled: bill.length, attention, locked: lock.locked });
}
