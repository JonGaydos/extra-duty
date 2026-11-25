import type { BillResult } from "@/domain/billing/bill";

/** What the deputy reads after billing, by where the invoice went. */
export function billMessage(delivery: BillResult["delivery"], status: BillResult["invoice"]["status"]): string {
  if (delivery === "approved_unsent" && status === "paid") return "Invoice billed and closed as paid. It is not emailed to this vendor.";
  if (delivery === "approved_unsent") return "Invoice billed. It is not emailed to this vendor; a coordinator sends it if needed.";
  if (delivery === "ready_to_send" && status === "paid") return "Invoice billed and closed as paid. It goes out marked Paid with the vendor's next invoice send.";
  if (delivery === "ready_to_send") return "Invoice approved. It goes out with the vendor's next invoice send.";
  if (delivery === "sent_queued" && status === "paid") return "Invoice billed and closed as paid. The vendor gets it marked Paid.";
  return delivery === "sent_queued" ? "Invoice sent to the vendor." : "Invoice sent to a coordinator for review.";
}
