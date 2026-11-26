import { Icon } from "@/ui/icons";

/** "Download PDF" for one invoice. The PDF route applies the access rule (staff: any state; others: their own). */
export function InvoicePdfLink({ id, number, compact = false }: Readonly<{ id: string; number: string; compact?: boolean }>) {
  return (
    <a href={`/api/v1/invoices/${id}/pdf`} className={`inline-flex min-h-11 w-fit items-center gap-1.5 font-semibold whitespace-nowrap ${compact ? "text-xs" : "text-sm"}`} download>
      <Icon name="download" size={16} />
      {compact ? "PDF" : "Download PDF"}
      <span className="sr-only"> for invoice {number}</span>
    </a>
  );
}
