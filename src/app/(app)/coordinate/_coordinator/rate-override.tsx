import type { RateOverride } from "@/domain/coordinator/views";
import { dateLabel } from "../../_personnel/format";

/** "Rate approved outside the agency range by Quinn Okafor, Nov 23, 2026: Holiday premium agreed with the vendor." */
function rateOverrideText(o: RateOverride): string {
  return `Rate approved outside the agency range by ${o.byName}, ${dateLabel(o.at)}: ${o.reason}`;
}

export function RateOverrideNote({ override }: Readonly<{ override: RateOverride }>) {
  return <span className="mt-1 block text-sm text-muted">{rateOverrideText(override)}</span>;
}
