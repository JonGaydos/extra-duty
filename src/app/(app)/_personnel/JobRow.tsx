import Link from "next/link";
import type { JobCard } from "@/domain/personnel/views";
import { Chip } from "@/ui/components/Chip";
import type { IconName } from "@/ui/icons";
import { MapsLink } from "@/ui/components/MapsLink";
import { PayLabel } from "@/ui/components/PayLabel";
import { detailTitle } from "@/domain/jobs/detail-name";
import { dateTime, hoursText, plural, whenText } from "./format";

/** The person's own place on the detail: signed up, offered to someone else, backup or pending a shorter shift. */
function mineChip(c: JobCard): RowChip | null {
  if (c.mine === "signed_up") return c.offered ? { tone: "warning", text: "Offered" } : { tone: "info", text: "Signed up" };
  if (c.mine === "backup") return { tone: "warning", text: "Backup" };
  if (c.mine === "pending_short") return { tone: "warning", text: "Pending shorter" };
  return null;
}

/** The status words for a job card, each with its tone. Color always comes with words. */
export function jobChips(c: JobCard): RowChip[] {
  const chips: RowChip[] = [];
  if (c.confidential) chips.push(CONFIDENTIAL_CHIP);
  const own = mineChip(c);
  if (own) chips.push(own);
  if (c.availability === "canceled") chips.push({ tone: "danger", text: "Canceled" });
  else if (c.held && c.availability !== "started") chips.push({ tone: "warning", text: "Held" });
  // A confidential detail is never released, so "Not released yet" would mislead.
  else if (c.availability === "not_released" && !c.confidential) chips.push({ tone: "neutral", text: "Not released yet" });
  else if (c.availability === "full") chips.push({ tone: "neutral", text: "Full" });
  else if (c.availability === "open" && !c.mine) chips.push({ tone: "attention", text: openText(c) });
  if (c.watching) chips.push({ tone: "info", text: "Watching" });
  if (c.flex) chips.push({ tone: "info", text: "Flexible times" });
  if (c.hasSafety) chips.push({ tone: "danger", text: "Officer safety info" });
  return chips;
}

/** "1 Deputy Sheriff spot left" for one open position, else "3 spots left". */
function openText(c: JobCard): string {
  const open = c.positions.filter((p) => p.count > p.filled);
  if (open.length === 1) {
    const n = open[0].count - open[0].filled;
    return `${n} ${open[0].name} ${n === 1 ? "spot" : "spots"} left`;
  }
  return `${plural(c.openSpots, "spot")} left`;
}

export type RowChip = { tone: "success" | "warning" | "danger" | "attention" | "info" | "neutral" | "coordinator"; text: string; icon?: IconName };

/** A confidential detail, wherever it is listed: staff-only purple with a lock, first among the chips. */
export const CONFIDENTIAL_CHIP: RowChip = { tone: "coordinator", text: "Confidential", icon: "lock" };

/** What a detail row shows, worked out on the server so the same row draws in server and client lists. */
export type RowView = {
  id: string;
  href: string;
  /** The vendor, as the row's linked title. */
  heading: string;
  /** The detail's title (staff also see its number). */
  sub: string;
  /** When, how long and where, in words. */
  when: string;
  pay: { totalCents: number; rateCents: number; maxTotalCents: number; maxRateCents: number };
  chips: RowChip[];
  address: string | null;
  lat: number | null;
  lng: number | null;
};

/** A job card as a row, named "#9 Title" for everyone. */
export function cardRow(card: JobCard, now: Date): RowView {
  const where = card.locationName ? `, ${card.locationName}` : "";
  const opens = card.availability === "not_released" && card.releaseAt ? `, opens ${dateTime(card.releaseAt)}` : "";
  return {
    id: card.id,
    href: `/jobs/${card.number}`,
    heading: card.vendorName,
    sub: detailTitle(card),
    when: `${whenText(card.startAt, card.endAt, now)}, ${hoursText(card.minutes)}${where}${opens}`,
    pay: { totalCents: card.totalCents, rateCents: card.rateCents, maxTotalCents: card.maxTotalCents, maxRateCents: card.maxRateCents },
    chips: jobChips(card),
    address: card.address,
    lat: card.lat,
    lng: card.lng,
  };
}

/**
 * One detail in a list: vendor, when and where, pay, and its status in words. The whole row is the link to the
 * detail page. `note` is a muted line under the when (staff: why bulk edit cannot change it).
 */
export function DetailRowBody({ row, extra, note }: Readonly<{ row: RowView; extra?: React.ReactNode; note?: string | null }>) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-2">
      <Link href={row.href} data-card-link className="group flex flex-col gap-1.5 text-ink no-underline hover:text-ink">
        <span className="flex items-start justify-between gap-3">
          <span className="flex min-w-0 flex-col">
            <span className="font-semibold underline decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2">{row.heading}</span>
            <span className="text-sm text-muted">{row.sub}</span>
          </span>
          <PayLabel totalCents={row.pay.totalCents} rateCents={row.pay.rateCents} upTo={{ totalCents: row.pay.maxTotalCents, rateCents: row.pay.maxRateCents }} />
        </span>
        <span className="text-sm text-muted" data-numeric>
          {row.when}
        </span>
        {note ? <span className="text-xs font-medium text-muted">Not editable: {note}</span> : null}
      </Link>
      {row.chips.length > 0 || extra || row.address ? (
        <span className="flex flex-wrap items-center gap-1.5">
          {row.chips.map((c) => (
            <Chip key={c.text} tone={c.tone} icon={c.icon}>
              {c.text}
            </Chip>
          ))}
          {extra}
          {row.address ? <MapsLink address={row.address} lat={row.lat} lng={row.lng} className="ml-auto" /> : null}
        </span>
      ) : null}
    </div>
  );
}

/** A job card in a list, as everyone sees it. */
export function JobRow({ card, now, extra }: Readonly<{ card: JobCard; now: Date; extra?: React.ReactNode }>) {
  return (
    <div className="flex px-4 py-3.25">
      <DetailRowBody row={cardRow(card, now)} extra={extra} />
    </div>
  );
}

/** A plain list of rows inside one card, divided. */
export function RowList({ children, label }: Readonly<{ children: React.ReactNode; label?: string }>) {
  return (
    <ul aria-label={label} className="m-0 flex list-none flex-col divide-y divide-divider p-0">
      {children}
    </ul>
  );
}
