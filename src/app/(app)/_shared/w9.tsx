import type { W9Row } from "@/domain/w9/w9";
import { dayText } from "@/domain/w9/w9";
import { Chip, type ChipTone } from "@/ui/components/Chip";

const STATUS: Record<W9Row["status"], { label: string; tone: ChipTone }> = {
  approved: { label: "Approved", tone: "success" },
  pending: { label: "Pending review", tone: "warning" },
  rejected: { label: "Not approved", tone: "danger" },
};

/** " by Casey Oakes" when staff uploaded it for the person, else nothing. */
export const uploadedBy = (name: string | null) => (name ? ` by ${name}` : "");

/** The review status of one W-9 as a chip. */
export function W9StatusChip({ status }: Readonly<{ status: W9Row["status"] }>) {
  return <Chip tone={STATUS[status].tone}>{STATUS[status].label}</Chip>;
}

/** "Signed Jan 15, 2026, March 2024 form", or "Signature date unknown" for a W-9 approved when review began. */
export function signedText(w9: Pick<W9Row, "signedOn" | "formRevision" | "grandfathered">): string {
  if (!w9.signedOn) return w9.grandfathered ? "On file before W-9 review began. Signature date unknown" : "Signature date unknown";
  const form = w9.formRevision ? `, ${w9.formRevision} form` : "";
  return `Signed ${dayText(w9.signedOn)}${form}`;
}
