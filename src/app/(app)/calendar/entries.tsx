import Link from "next/link";
import { ActionLink } from "@/ui/components/Button";
import { MapsLink } from "@/ui/components/MapsLink";
import { STATUS_LABEL, type CalEntry, type CalStatus } from "@/domain/calendar/calendar";
import { Chip } from "@/ui/components/Chip";
import { PayLabel } from "@/ui/components/PayLabel";
import { clock, timeRange } from "../_personnel/format";

/** Status stripe colors. Steady, never animated, and always next to the status in words. */
const STRIPE: Record<CalStatus, string> = {
  open: "bg-cal-open",
  filled: "bg-cal-filled",
  past: "bg-cal-past",
  not_released: "bg-cal-unreleased",
  requested: "bg-coordinator-ink",
  canceled: "bg-field",
};

export const TONE: Record<CalStatus, "success" | "danger" | "neutral" | "warning" | "coordinator"> = {
  open: "success",
  filled: "danger",
  past: "neutral",
  not_released: "warning",
  requested: "coordinator",
  canceled: "neutral",
};

const MINE_LABEL: Record<string, string> = { signed_up: "Signed up", backup: "Backup", pending_short: "Pending shorter", billed: "Billed", paid: "Paid" };

/** "Vendor or title, Place", or the first part alone when there is no place. */
export const withPlace = (text: string, place: string | null) => (place ? `${text}, ${place}` : text);

/** Where an entry opens: the detail page everyone shares (staff find their controls on it). */
export const entryHref = (e: CalEntry) => `/jobs/${e.number}`;

export type EntryChip = { tone: (typeof TONE)[CalStatus] | "warning"; text: string; icon?: "lock" };

/**
 * The entry's status chips: Confidential (staff purple, lock) when it applies, the status word and Held. A
 * confidential detail is never released, so Confidential stands in for "Not released" rather than beside it.
 */
export function entryChips(e: Pick<CalEntry, "status" | "confidential" | "held">): EntryChip[] {
  const chips: EntryChip[] = [];
  if (e.confidential) chips.push({ tone: "coordinator", text: "Confidential", icon: "lock" });
  if (!(e.confidential && e.status === "not_released")) chips.push({ tone: TONE[e.status], text: STATUS_LABEL[e.status] });
  if (e.held) chips.push({ tone: "warning", text: "Held" });
  return chips;
}

/** What a screen reader hears after the entry's text. */
function statusWords(e: CalEntry): string {
  return [...entryChips(e).map((c) => c.text), e.mine ? "you are on it" : null].filter(Boolean).join(", ");
}

/** "7:00 AM Vendor name" in a month cell, with the title on hover. */
export function CompactEntry({ e }: Readonly<{ e: CalEntry }>) {
  return (
    <Link
      href={entryHref(e)}
      title={withPlace(e.title, e.locationName)}
      data-card-link
      className="group flex min-h-6 items-stretch gap-1.5 rounded-xs py-0.5 pr-1 text-xs text-ink no-underline hover:bg-subtle hover:text-ink"
    >
      <span className={`w-1 shrink-0 rounded-full ${STRIPE[e.status]}`} aria-hidden />
      <span className={`min-w-0 truncate ${e.status === "canceled" ? "text-muted line-through" : ""}`}>
        <span className="font-semibold" data-numeric>
          {clock(e.startAt)}
        </span>{" "}
        <span className="underline decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2">{e.vendorName}</span>
        {e.mine ? <span className="font-semibold text-link"> (you)</span> : null}
      </span>
      <span className="sr-only">
        , {e.title}. {statusWords(e)}
      </span>
    </Link>
  );
}

/** One entry in the day, week and list views. `manage`: a vendor manager's own vendor, with a link to Manage this detail. */
export function EntryRow({ e, manage = false }: Readonly<{ e: CalEntry; manage?: boolean }>) {
  return (
    <div className="flex flex-col rounded-md border border-line bg-surface">
      <Link href={entryHref(e)} data-card-link className="group flex items-stretch gap-3 rounded-md py-2.5 pr-3 pl-2.5 text-ink no-underline hover:bg-subtle hover:text-ink">
        <span className={`w-1.5 shrink-0 rounded-full ${STRIPE[e.status]}`} aria-hidden />
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="flex flex-wrap items-center justify-between gap-2">
            <span className={`font-semibold ${e.status === "canceled" ? "[text-decoration-line:underline_line-through]" : "underline"} decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2`}>{e.vendorName}</span>
            <span className="flex flex-wrap gap-1.5">
              {entryChips(e).map((c) => (
                <Chip key={c.text} tone={c.tone} icon={c.icon}>
                  {c.text}
                </Chip>
              ))}
              {e.mine ? <Chip tone="info">{MINE_LABEL[e.myStatus ?? "signed_up"] ?? "Yours"}</Chip> : null}
            </span>
          </span>
          <span className={`text-sm text-muted ${e.status === "canceled" ? "line-through" : ""}`}>
            {timeRange(e.startAt, e.endAt)}, #{e.number} {e.title}
            {e.locationName ? `, ${e.locationName}` : ""}
          </span>
          <PayLabel variant="plain" totalCents={e.pay.totalCents} rateCents={e.pay.rateCents} upTo={{ totalCents: e.pay.maxTotalCents, rateCents: e.pay.maxRateCents }} />
        </span>
      </Link>
      {e.address || e.lat !== null || manage ? (
        <span className="flex flex-wrap items-center gap-x-4 border-t border-divider pr-3 pl-5">
          {e.address || e.lat !== null ? <MapsLink address={e.address} lat={e.lat} lng={e.lng} /> : null}
          {manage ? (
            <ActionLink href={`/jobs/${e.number}?tab=manage`} icon="sliders" aria-label={`Manage detail #${e.number}`}>
              Manage
            </ActionLink>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

const LEGEND: Array<[CalStatus, string]> = [
  ["open", "Open"],
  ["filled", "Filled"],
  ["not_released", "Not released or held"],
  ["past", "Past"],
  ["requested", "Vendor request"],
  ["canceled", "Canceled (struck through)"],
];

/** The color key under the calendar. */
export function Legend({ staff }: Readonly<{ staff: boolean }>) {
  return (
    <ul className="m-0 flex list-none flex-wrap gap-x-4 gap-y-1.5 p-0 text-xs text-muted" aria-label="Color key">
      {LEGEND.filter(([s]) => staff || s !== "requested").map(([s, text]) => (
        <li key={s} className="flex items-center gap-1.5">
          <span className={`h-3.5 w-1.5 rounded-full ${STRIPE[s]}`} aria-hidden />
          <span className={s === "canceled" ? "line-through decoration-1" : ""}>{text}</span>
        </li>
      ))}
      <li className="flex items-center gap-1.5">
        <span className="font-semibold text-link">(you)</span> You are on it
      </li>
    </ul>
  );
}
