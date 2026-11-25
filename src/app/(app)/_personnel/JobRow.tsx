import Link from "next/link";
import type { JobCard } from "@/domain/personnel/views";
import { Chip } from "@/ui/components/Chip";
import { MapsLink } from "@/ui/components/MapsLink";
import { PayLabel } from "@/ui/components/PayLabel";
import { dateTime, hoursText, plural, whenText } from "./format";

/** The status words for a job card, each with its tone. Color always comes with words. */
export function jobChips(c: JobCard): Array<{ tone: "success" | "warning" | "danger" | "attention" | "info" | "neutral"; text: string }> {
  const chips: ReturnType<typeof jobChips> = [];
  if (c.mine === "signed_up") chips.push({ tone: "info", text: "Signed up" });
  else if (c.mine === "backup") chips.push({ tone: "warning", text: "Backup" });
  else if (c.mine === "pending_short") chips.push({ tone: "warning", text: "Pending shorter" });
  if (c.availability === "canceled") chips.push({ tone: "danger", text: "Canceled" });
  else if (c.held && c.availability !== "started") chips.push({ tone: "warning", text: "Held" });
  else if (c.availability === "not_released") chips.push({ tone: "neutral", text: "Not released yet" });
  else if (c.availability === "full") chips.push({ tone: "neutral", text: "Full" });
  else if (c.availability === "open" && !c.mine) chips.push({ tone: "attention", text: openText(c) });
  if (c.watching) chips.push({ tone: "info", text: "Watching" });
  if (c.flex) chips.push({ tone: "info", text: "Flexible times" });
  if (c.hasSafety) chips.push({ tone: "danger", text: "Officer safety info" });
  return chips;
}

/** "1 Deputy Sheriff spot left" for one open position, else "3 spots left". */
export function openText(c: JobCard): string {
  const open = c.positions.filter((p) => p.count > p.filled);
  if (open.length === 1) {
    const n = open[0].count - open[0].filled;
    return `${n} ${open[0].name} ${n === 1 ? "spot" : "spots"} left`;
  }
  return `${plural(c.openSpots, "spot")} left`;
}

/**
 * One detail in a list: vendor, when and where, pay, and its status in words. The whole row is the link to
 * the detail page.
 */
export function JobRow({ card, now, extra }: { card: JobCard; now: Date; extra?: React.ReactNode }) {
  const chips = jobChips(card);
  return (
    <div className="flex flex-col gap-2 px-4 py-3.25">
      <Link href={`/jobs/${card.id}`} data-card-link className="group flex flex-col gap-1.5 text-ink no-underline hover:text-ink">
        <span className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold underline decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2">{card.vendorName}</span>
            <span className="text-sm text-muted">{card.title}</span>
          </span>
          <PayLabel totalCents={card.totalCents} rateCents={card.rateCents} upTo={{ totalCents: card.maxTotalCents, rateCents: card.maxRateCents }} />
        </span>
        <span className="text-sm text-muted" data-numeric>
          {whenText(card.startAt, card.endAt, now)}, {hoursText(card.minutes)}
          {card.locationName ? `, ${card.locationName}` : ""}
          {card.availability === "not_released" && card.releaseAt ? `, opens ${dateTime(card.releaseAt)}` : ""}
        </span>
      </Link>
      {chips.length > 0 || extra || card.address ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {chips.map((c) => (
            <Chip key={c.text} tone={c.tone}>
              {c.text}
            </Chip>
          ))}
          {extra}
          {card.address ? <MapsLink address={card.address} lat={card.lat} lng={card.lng} className="ml-auto" /> : null}
        </span>
      ) : null}
    </div>
  );
}

/** A plain list of rows inside one card, divided. */
export function RowList({ children, label }: { children: React.ReactNode; label?: string }) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col divide-y divide-divider p-0">
      {children}
    </ul>
  );
}
