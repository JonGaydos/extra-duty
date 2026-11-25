import { and, eq, gte, isNotNull } from "drizzle-orm";
import { withTx } from "@/db/client";
import { invoiceEvents, invoices } from "@/db/schema";
import { isOverdue } from "@/domain/billing/payments";
import { formatInvoiceNumber } from "@/domain/invoices/invoices";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";
import { vendorEmail } from "@/domain/payment-issues/issues";
import { getSettings } from "@/domain/settings/settings";

/**
 * Daily tick (7:10 AM agency time). When the party responsible for an invoice passes its response time, writes
 * one `overdue` timeline event for that stretch of responsibility (once per invoice, party and
 * `responsibleSince`), then: vendor, a reminder email to its billing addresses when `vendorReminderEnabled`;
 * coordinator, an alert to all coordinators and admins; deputy, nothing more (the sign-up lock handles it).
 * Returns the number of new overdue events. One failing invoice is logged and skipped.
 */
export async function responseDeadlinesTick(now: Date): Promise<number> {
  const due = await withTx(async (tx) => {
    const s = await getSettings(tx);
    const rows = await tx
      .select({ id: invoices.id, responsibleParty: invoices.responsibleParty, responsibleSince: invoices.responsibleSince })
      .from(invoices)
      .where(and(isNotNull(invoices.responsibleParty), isNotNull(invoices.responsibleSince)));
    return rows.filter((r) => isOverdue(r, now, s)).map((r) => r.id).sort();
  });
  let written = 0;
  for (const id of due) {
    try {
      written += await withTx(async (tx) => {
        const [inv] = await tx.select().from(invoices).where(eq(invoices.id, id)).for("update");
        const s = await getSettings(tx);
        if (!inv?.responsibleParty || !inv.responsibleSince || !isOverdue(inv, now, s)) return 0;
        const party = inv.responsibleParty;
        const [done] = await tx
          .select({ id: invoiceEvents.id })
          .from(invoiceEvents)
          .where(and(eq(invoiceEvents.invoiceId, id), eq(invoiceEvents.event, "overdue"), eq(invoiceEvents.party, party), gte(invoiceEvents.at, inv.responsibleSince)))
          .limit(1);
        if (done) return 0;
        const number = formatInvoiceNumber(s.invoiceNumberPrefix, inv.number);
        let note: string | null = null;
        if (party === "vendor" && s.vendorReminderEnabled) {
          const sent = await vendorEmail(
            tx,
            inv,
            "invoice.vendor_payment_reminder",
            `Payment reminder: invoice ${number}`,
            "This invoice has not been marked paid and is past its response time.",
            ["If you have already paid, please mark it paid in the vendor portal."],
          );
          note =
            sent === "sent" ? "Reminder emailed to the vendor" : sent === "off" ? "Reminder not sent: the agency turned this email off" : "Reminder not sent: the vendor has no billing email";
        }
        await tx.insert(invoiceEvents).values({ invoiceId: id, event: "overdue", party, note, vendorVisible: false, at: now });
        if (party === "coordinator") {
          await emit(
            tx,
            {
              recipients: await coordinatorAudience(tx),
              type: "payment_issue.overdue",
              title: "Payment issue overdue",
              body: `Invoice ${number} has been with the coordinators for more than ${s.responseDays.coordinator} days.`,
              link: `/invoices/${id}`,
            },
            now,
          );
        }
        return 1;
      });
    } catch (err) {
      console.error(`Failed overdue check for invoice ${id}:`, err);
    }
  }
  return written;
}
