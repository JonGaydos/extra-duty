import sharp from "sharp";
import { eq } from "drizzle-orm";
import type { Tx } from "@/db/client";
import { assignments, files, invoices, jobs, paymentMethods, users, vendorLocations, vendors } from "@/db/schema";
import { recordAudit } from "@/domain/audit/audit";
import { invoiceTotal, resolveMinimum } from "@/domain/billing/rules";
import { NotFoundError } from "@/domain/errors";
import { getSettings } from "@/domain/settings/settings";
import { minutesBetween } from "@/domain/time/agency-time";
import type { Cents, Minutes } from "@/domain/types";
import type { InvoicePdfData } from "@/lib/pdf/invoice-pdf";
import { getStorage, type Storage } from "@/lib/storage";

const LOGO_TYPES = new Set(["image/png", "image/jpeg"]);

export type Invoice = typeof invoices.$inferSelect;

export type CreateInvoiceInput = {
  assignmentId: string;
  minutes: Minutes;
  rateCents: Cents;
  status: Invoice["status"];
};

/** The display number: prefix plus the sequence value zero-padded to six digits. */
export function formatInvoiceNumber(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(6, "0")}`;
}

/**
 * Creates the invoice row. `number` comes from the table's Postgres sequence,
 * so concurrent callers never share one. Vendor and payee come from the
 * assignment; the caller (a billing service) authorizes the action.
 */
export async function createInvoice(tx: Tx, input: CreateInvoiceInput): Promise<Invoice> {
  const [row] = await tx
    .select({ userId: assignments.userId, vendorId: jobs.vendorId })
    .from(assignments)
    .innerJoin(jobs, eq(jobs.id, assignments.jobId))
    .where(eq(assignments.id, input.assignmentId));
  if (!row) throw new NotFoundError("Assignment not found.");
  const [invoice] = await tx
    .insert(invoices)
    .values({
      assignmentId: input.assignmentId,
      vendorId: row.vendorId,
      payeeUserId: row.userId,
      minutes: input.minutes,
      rateCents: input.rateCents,
      totalCents: invoiceTotal(input.minutes, input.rateCents),
      status: input.status,
    })
    .returning();
  await recordAudit(tx, {
    actor: "system",
    action: "invoice.create",
    entityType: "invoice",
    entityId: invoice.id,
    after: {
      number: invoice.number,
      assignmentId: invoice.assignmentId,
      vendorId: invoice.vendorId,
      payeeUserId: invoice.payeeUserId,
      minutes: invoice.minutes,
      rateCents: invoice.rateCents,
      totalCents: invoice.totalCents,
      status: invoice.status,
    },
  });
  return invoice;
}

/** Agency name, Sheriff, contact lines and logo, as every PDF header shows them. */
export async function loadAgencyHeader(tx: Tx, storage?: Storage): Promise<InvoicePdfData["agency"]> {
  const { agency } = await getSettings(tx);
  let logo: InvoicePdfData["agency"]["logo"] = null;
  if (agency.logoFileId) {
    const [file] = await tx.select().from(files).where(eq(files.id, agency.logoFileId));
    if (file && !file.encrypted && LOGO_TYPES.has(file.contentType)) {
      const bytes = await (storage ?? getStorage()).get(file.storageKey);
      // Sizes are kept in settings; a logo saved before that has its header read (nothing is decoded).
      const size = agency.logoWidth && agency.logoHeight ? { width: agency.logoWidth, height: agency.logoHeight } : await sharp(bytes).metadata().then((m) => ({ width: m.width ?? null, height: m.height ?? null }), () => ({ width: null, height: null }));
      logo = { bytes, mimeType: file.contentType, ...size };
    }
  }
  return { name: agency.name, sheriffName: agency.sheriffName, address: agency.address, phone: agency.phone, website: agency.website, logo };
}

/** Loads everything the invoice PDF shows. */
export async function buildInvoicePdfData(tx: Tx, invoiceId: string, storage?: Storage): Promise<InvoicePdfData> {
  const [inv] = await tx.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!inv) throw new NotFoundError("Invoice not found.");
  const [assignment] = await tx.select().from(assignments).where(eq(assignments.id, inv.assignmentId));
  const [job] = await tx.select().from(jobs).where(eq(jobs.id, assignment.jobId));
  const [vendor] = await tx.select().from(vendors).where(eq(vendors.id, inv.vendorId));
  const [payee] = await tx.select().from(users).where(eq(users.id, inv.payeeUserId));
  const settings = await getSettings(tx);

  let location = "";
  if (job.locationId) {
    const [loc] = await tx.select().from(vendorLocations).where(eq(vendorLocations.id, job.locationId));
    if (loc) location = [loc.name, loc.address].filter(Boolean).join(", ");
  }

  const start = assignment.actualStartAt ?? assignment.plannedStartAt ?? job.startAt;
  const end = assignment.actualEndAt ?? assignment.plannedEndAt ?? job.endAt;
  const minimumMinutes = inv.minimumOverrideMinutes ?? resolveMinimum(job.minimumBillableMinutes, vendor.minimumBillableMinutes, settings.minimumBillableMinutes);

  const vendorPaid = inv.vendorPaidAt !== null;
  const paidAt = inv.vendorPaidAt ?? inv.deputyPaidAt;
  const methodId = vendorPaid ? inv.vendorPaidMethodId : inv.deputyMethodId;
  const reference = vendorPaid ? inv.vendorPaidReference : inv.deputyReference;
  let paid: InvoicePdfData["paid"] = null;
  if (paidAt) {
    const method = methodId ? (await tx.select().from(paymentMethods).where(eq(paymentMethods.id, methodId)))[0]?.name : undefined;
    paid = { method: method ?? "", reference: reference ?? "", paidAt };
  }

  return {
    number: formatInvoiceNumber(settings.invoiceNumberPrefix, inv.number),
    revision: inv.revision,
    kind: inv.kind,
    issuedAt: inv.createdAt,
    vendor: { name: vendor.name, billingEmails: vendor.billingEmails },
    job: { number: job.number, title: job.title, location, startAt: job.startAt, endAt: job.endAt },
    payee: { name: payee.name, mailingAddress: payee.mailingAddress ?? "", email: payee.email },
    agency: await loadAgencyHeader(tx, storage),
    workedMinutes: inv.kind === "late_cancel" ? 0 : minutesBetween(start, end),
    minutes: inv.minutes,
    minimumMinutes,
    rateCents: inv.rateCents,
    totalCents: inv.totalCents,
    paid,
    replyTo: settings.billingReplyToEmail || settings.agency.email,
  };
}
