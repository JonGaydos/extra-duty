import Link from "next/link";
import { Icon } from "../icons";

/** The alerts bell: a link to /alerts with an unread badge that states the count in words. */
export function AlertsBell({ unread, size = "sm" }: Readonly<{ unread: number; size?: "sm" | "md" }>) {
  const label = unread > 0 ? `Alerts, ${unread} unread` : "Alerts";
  return (
    <Link
      href="/alerts"
      aria-label={label}
      data-nav-item
      className={`relative flex items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink ${
        size === "md" ? "size-11" : "size-9 pointer-coarse:size-11"
      }`}
    >
      <Icon name="bell" size={20} />
      {unread > 0 ? (
        <span aria-hidden className="absolute -top-1 -right-1 flex h-4.5 min-w-4.5 items-center justify-center rounded-full border border-attention-dot bg-attention-soft px-1 text-micro leading-none font-bold text-attention-ink" data-numeric>
          {unread > 99 ? "99+" : unread}
        </span>
      ) : null}
    </Link>
  );
}
