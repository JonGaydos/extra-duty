import { invoiceTimeline } from "@/domain/billing/payments";
import { buildInvoicePdfData } from "@/domain/invoices/invoices";
import { apiHandler } from "@/lib/api/handler";
import { routes } from "@/lib/api/registry";
import { renderInvoicePdf } from "@/lib/pdf/invoice-pdf";
import { attachment } from "../../../files";

/** The invoice PDF for the payee, the invoice's vendor (once sent), coordinators and admins. */
export const GET = apiHandler(routes["GET /invoices/{id}/pdf"], async ({ actor, params, run }) => {
  const data = await run(async (tx) => {
    // The timeline read applies the invoice's access rule; it throws for anyone else.
    await invoiceTimeline(actor, tx, params.id);
    return buildInvoicePdfData(tx, params.id);
  });
  return attachment(await renderInvoicePdf(data), "application/pdf", `${data.number}.pdf`);
});
