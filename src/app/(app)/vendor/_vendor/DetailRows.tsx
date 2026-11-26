import Link from "next/link";
import { VENDOR_STATUS_LABEL, type VendorDetailRow, type VendorDetailStatus } from "@/domain/vendor-portal/views";
import { Card } from "@/ui/components/Card";
import { Chip, type ChipTone } from "@/ui/components/Chip";
import { dayLabel, timeRange } from "../../_personnel/format";

const STATUS_TONE: Record<VendorDetailStatus, ChipTone> = {
  requested: "coordinator",
  scheduled: "info",
  filled: "success",
  past: "neutral",
  canceled: "neutral",
  declined: "danger",
};

export function StatusChip({ status }: Readonly<{ status: VendorDetailStatus }>) {
  return <Chip tone={STATUS_TONE[status]}>{VENDOR_STATUS_LABEL[status]}</Chip>;
}

/** "1 of 2 filled", while spots are still open. */
function staffingText(d: Pick<VendorDetailRow, "status" | "needed" | "filled">): string | null {
  if (d.status !== "scheduled") return null;
  return `${Math.min(d.filled, d.needed)} of ${d.needed} filled`;
}

/** A card of detail rows; each row opens the detail and underlines its title. */
export function DetailRows({ rows }: Readonly<{ rows: VendorDetailRow[] }>) {
  return (
    <Card pad={false} as="div">
      <ul className="m-0 list-none divide-y divide-divider p-0">
        {rows.map((d) => {
          const staffing = staffingText(d);
          const closed = d.status === "canceled" || d.status === "declined";
          return (
            <li key={d.id}>
              <Link
                href={`/vendor/details/${d.id}`}
                data-card-link
                className="group flex flex-col gap-1.5 px-4 py-3.25 text-ink no-underline first:rounded-t-xl last:rounded-b-xl hover:bg-subtle hover:text-ink md:flex-row md:items-center md:justify-between md:gap-4 md:first:rounded-t-2xl md:last:rounded-b-2xl"
              >
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span
                    className={`font-semibold decoration-current/50 decoration-1 underline-offset-3 group-hover:decoration-current group-hover:decoration-2 ${closed ? "[text-decoration-line:underline_line-through]" : "underline"}`}
                  >
                    {d.title}
                  </span>
                  <span className="text-sm text-muted">
                    {dayLabel(d.startAt)}, {timeRange(d.startAt, d.endAt)}
                    {d.locationName ? `, ${d.locationName}` : ""}
                    <span data-numeric>, #{d.number}</span>
                  </span>
                </span>
                <span className="flex shrink-0 flex-wrap items-center gap-1.5">
                  <StatusChip status={d.status} />
                  {d.pendingChange ? <Chip tone="warning">Change waiting for approval</Chip> : null}
                  {staffing ? (
                    <span className="text-sm text-muted" data-numeric>
                      {staffing}
                    </span>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </Card>
  );
}
