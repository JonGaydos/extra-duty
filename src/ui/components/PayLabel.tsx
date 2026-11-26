import type { Cents } from "@/domain/types";

const WHOLE = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 0, maximumFractionDigits: 0 });
const EXACT = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** "$280" for whole dollars, "$506.25" otherwise. */
export function dollars(cents: Cents): string {
  return cents % 100 === 0 ? WHOLE.format(cents / 100) : EXACT.format(cents / 100);
}

/** "$280 at $70/hr". */
export function payText(totalCents: Cents, rateCents: Cents): string {
  return `${dollars(totalCents)} at ${dollars(rateCents)}/hr`;
}

/** "$280 to $380 at $70 to $95/hr" when positions pay differently. */
export function payRangeText(low: { totalCents: Cents; rateCents: Cents }, high: { totalCents: Cents; rateCents: Cents }): string {
  if (high.totalCents === low.totalCents && high.rateCents === low.rateCents) return payText(low.totalCents, low.rateCents);
  return `${dollars(low.totalCents)} to ${dollars(high.totalCents)} at ${dollars(low.rateCents)} to ${dollars(high.rateCents)}/hr`;
}

/**
 * The only way a screen shows a detail's pay: the total and the hourly rate
 * together, on every list, card, map pin and summary. `pill` for lists and
 * cards, `plain` inside sentences and summaries.
 */
export function PayLabel({
  totalCents,
  rateCents,
  upTo,
  variant = "pill",
}: Readonly<{
  totalCents: Cents;
  rateCents: Cents;
  /** The highest-paid position (an Incident Commander's differential), shown as a range when it pays more. */
  upTo?: { totalCents: Cents; rateCents: Cents } | null;
  variant?: "pill" | "plain";
}>) {
  const range = upTo && (upTo.totalCents !== totalCents || upTo.rateCents !== rateCents) ? upTo : null;
  const total = range ? `${dollars(totalCents)} to ${dollars(range.totalCents)}` : dollars(totalCents);
  const rate = range ? `${dollars(rateCents)} to ${dollars(range.rateCents)}` : dollars(rateCents);
  if (variant === "plain") {
    return (
      <span className="font-semibold whitespace-nowrap" data-numeric>
        {total}
        <span className="font-normal text-muted"> at {rate}/hr</span>
      </span>
    );
  }
  return (
    <span
      className="inline-flex w-fit items-baseline rounded-full bg-success-soft px-2.25 py-0.75 text-body font-semibold whitespace-nowrap text-success-ink"
      data-numeric
    >
      {total}
      <span className="text-xs font-medium"> at {rate}/hr</span>
    </span>
  );
}
