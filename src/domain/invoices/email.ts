import { and, eq, isNull } from "drizzle-orm";
import { withTx, type Tx } from "@/db/client";
import { invoices, notifications, vendors } from "@/db/schema";
import { coordinatorAudience } from "@/domain/notifications/audiences";
import { emit } from "@/domain/notifications/notify";
import { recordAudit } from "@/domain/audit/audit";
import { DomainError, NotFoundError, ValidationError } from "@/domain/errors";
import { getSettings } from "@/domain/settings/settings";
import { readW9ForInvoiceEmail } from "@/domain/w9/w9";
import { queueInvoiceJob } from "@/jobs/boss";
import { emailConfigProblem, REPLY_TO_PROBLEM, settingsProblemMessage, type SettingsProblem } from "@/lib/email/provider";
import { outboxActive } from "@/lib/email/outbox";
import { getEmailSender } from "@/lib/email/sender";
import { invoiceEmail } from "@/lib/email/templates/invoice";
import type { OutgoingEmail } from "@/lib/email/types";
import { formatMoney, renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import type { Storage } from "@/lib/storage";
import { buildInvoicePdfData, formatInvoiceNumber } from "./invoices";

const PURPOSE = "sending invoices";

/** What must be set before invoices can be emailed. The email provider is not needed where everything goes to the outbox. */
export function invoiceSettingsProblem(email: Parameters<typeof emailConfigProblem>[0], replyTo: string): SettingsProblem | null {
  return (outboxActive() ? null : emailConfigProblem(email)) ?? (replyTo.trim() ? null : REPLY_TO_PROBLEM);
}

/**
 * Tells coordinators and admins what to set, once per person until they read it. It commits in its own
 * transaction: the caller's transaction rolls back with the error that follows, and the alert must outlive it.
 */
async function alertSettingsIncomplete(message: string): Promise<void> {
  await withTx(async (tx) => {
    // Sequential: the reads and alert writes share this transaction.
    for (const id of await coordinatorAudience(tx)) {
      const [open] = await tx
        .select({ id: notifications.id })
        .from(notifications)
        .where(and(eq(notifications.userId, id), eq(notifications.type, "settings.email_incomplete"), isNull(notifications.readAt)))
        .limit(1);
      if (open) continue;
      await emit(tx, { recipients: [id], type: "settings.email_incomplete", title: "Email settings are incomplete", body: message, link: "/settings" });
    }
  });
}

/**
 * Queues a resend of an invoice already sent, to `to`, inside the caller's transaction. Same checks and the same
 * failure reporting as the first send; the email is built at send time, so a paid invoice goes as its paid version.
 */
export async function queueInvoiceResend(tx: Tx, invoiceId: string, to: string[], opts: { noW9?: true; w9ReadBy?: string } = {}): Promise<void> {
  const [row] = await tx
    .select({ vendorName: vendors.name, billingEmails: vendors.billingEmails })
    .from(invoices)
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(eq(invoices.id, invoiceId));
  if (!row) throw new NotFoundError("Invoice not found.");
  await assertInvoiceEmailReady(tx, row);
  await tx.update(invoices).set({ emailStatus: "queued" }).where(eq(invoices.id, invoiceId));
  await queueInvoiceJob(tx, invoiceId, { to, ...opts });
}

/**
 * Queues the invoice email inside the caller's transaction and sets the invoice's emailStatus to queued.
 * Fails fast, with a message a coordinator can act on, when the email provider or the billing reply-to
 * address is not set, or the vendor has no billing email. Settings problems also notify coordinators.
 */
export async function queueInvoiceEmail(tx: Tx, invoiceId: string): Promise<void> {
  const [row] = await tx
    .select({ vendorName: vendors.name, billingEmails: vendors.billingEmails })
    .from(invoices)
    .innerJoin(vendors, eq(vendors.id, invoices.vendorId))
    .where(eq(invoices.id, invoiceId));
  if (!row) throw new NotFoundError("Invoice not found.");
  await assertInvoiceEmailReady(tx, row);

  await tx.update(invoices).set({ emailStatus: "queued" }).where(eq(invoices.id, invoiceId));
  await queueInvoiceJob(tx, invoiceId);
}

/**
 * Throws, with a message a coordinator can act on, when invoices cannot be emailed to this vendor: the email
 * provider or the billing reply-to address is not set (coordinators are also alerted), or it has no billing email.
 */
export async function assertInvoiceEmailReady(tx: Tx, row: { vendorName: string; billingEmails: string[] }): Promise<void> {
  const settings = await getSettings(tx);
  const settingsProblem = invoiceSettingsProblem(settings.email, settings.billingReplyToEmail);
  if (settingsProblem) {
    const message = settingsProblemMessage(settingsProblem, PURPOSE);
    await alertSettingsIncomplete(message);
    throw new ValidationError(message);
  }
  if (!row.billingEmails.length) {
    throw new ValidationError(`Add a billing email to ${row.vendorName} before sending invoices.`);
  }
}

/** Builds the message at send time: renders the PDF and, when asked, reads the payee's current W-9 (audited). Exported for tests. */
export async function buildInvoiceMessage(tx: Tx, invoiceId: string, storage?: Storage, opts: { noW9?: boolean; w9ReadBy?: string } = {}): Promise<OutgoingEmail> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new NotFoundError("Invoice not found.");
  const settings = await getSettings(tx);
  const problem = invoiceSettingsProblem(settings.email, settings.billingReplyToEmail);
  if (problem) throw new ValidationError(settingsProblemMessage(problem, PURPOSE));
  const data = await buildInvoicePdfData(tx, invoiceId, storage);
  if (!data.vendor.billingEmails.length) throw new ValidationError(`Add a billing email to ${data.vendor.name} before sending invoices.`);

  const pdf = await renderInvoicePdf(data);
  const attachments: NonNullable<OutgoingEmail["attachments"]> = [
    { filename: `${data.number}.pdf`, content: pdf, contentType: "application/pdf" },
  ];
  const withW9 = inv.attachW9 && !opts.noW9;
  if (withW9) {
    const w9 = await readW9ForInvoiceEmail(tx, invoiceId, storage, opts.w9ReadBy ?? inv.w9RequestedBy ?? undefined);
    attachments.push({ filename: `W-9 ${data.payee.name}.pdf`, content: w9.body, contentType: "application/pdf" });
  }
  return {
    ...invoiceEmail({
      to: data.vendor.billingEmails,
      replyTo: settings.billingReplyToEmail,
      invoiceNumber: data.number,
      jobNumber: data.job.number,
      agencyName: data.agency.name,
      payeeName: data.payee.name,
      total: formatMoney(data.totalCents),
      withW9,
      revision: inv.revision,
    }),
    attachments,
  };
}

async function markFailed(invoiceId: string, reason: string, summary: string): Promise<void> {
  await withTx(async (tx) => {
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
    if (!inv || inv.emailStatus === "failed") return;
    await tx.update(invoices).set({ emailStatus: "failed" }).where(eq(invoices.id, invoiceId));
    await recordAudit(tx, {
      actor: "system",
      action: "invoice.email_failed",
      entityType: "invoice",
      entityId: invoiceId,
      before: { emailStatus: inv.emailStatus },
      after: { emailStatus: "failed", reason },
    });
    const { invoiceNumberPrefix } = await getSettings(tx);
    const number = formatInvoiceNumber(invoiceNumberPrefix, inv.number);
    const recipients = new Set([inv.payeeUserId, ...(await coordinatorAudience(tx))]);
    await emit(tx, {
      recipients: [...recipients],
      type: "invoice.email_failed",
      title: `Invoice ${number} could not be emailed`,
      body: summary,
      link: `/invoices/${invoiceId}`,
    });
  });
}

const SUMMARY_DELIVERY =
  "The email provider did not accept the invoice after repeated attempts. A coordinator can check the email settings and resend it.";

async function markSent(invoiceId: string): Promise<void> {
  await withTx(async (tx) => {
    await tx.update(invoices).set({ emailStatus: "sent" }).where(eq(invoices.id, invoiceId));
    await recordAudit(tx, {
      actor: "system",
      action: "invoice.email_sent",
      entityType: "invoice",
      entityId: invoiceId,
      after: { emailStatus: "sent" },
    });
  });
}

/**
 * Worker side of an invoice email job. Sends, then marks the invoice sent. A transient failure
 * rethrows so the queue retries (the invoice stays queued) until `finalAttempt`, when the invoice is
 * marked failed and the payee, coordinators and admins are alerted with a plain summary (the detailed
 * reason goes only in the audit row). A DomainError (for example no W-9 on file) will not fix itself,
 * so it fails at once without retrying. Once the send succeeds the job never throws, so the queue
 * cannot repeat it.
 */
export async function deliverInvoiceEmail(invoiceId: string, o: { finalAttempt: boolean; storage?: Storage; to?: string[]; noW9?: boolean; w9ReadBy?: string }): Promise<void> {
  try {
    const skip = await withTx(async (tx) => {
      const [inv] = await tx.select({ s: invoices.emailStatus, status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId));
      // A queued job for an invoice sent back in the meantime must not email it. A resend (`to`) goes even though
      // the invoice was sent before.
      return !inv || (inv.s === "sent" && !o.to) || inv.status === "returned";
    });
    if (skip) return;
    const built = await withTx((tx) => buildInvoiceMessage(tx, invoiceId, o.storage, { noW9: o.noW9, w9ReadBy: o.w9ReadBy }));
    const msg = o.to ? { ...built, to: o.to } : built;
    await getEmailSender().send(msg);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    if (err instanceof DomainError) {
      await markFailed(invoiceId, reason, `The invoice could not be emailed. ${reason}`);
      return;
    }
    if (o.finalAttempt) await markFailed(invoiceId, reason, SUMMARY_DELIVERY);
    throw err;
  }
  // Sequential: each attempt runs only after the previous one failed.
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await markSent(invoiceId);
      return;
    } catch (err) {
      console.error(`Invoice ${invoiceId} was emailed but marking it sent failed (attempt ${attempt}):`, err);
    }
  }
}
