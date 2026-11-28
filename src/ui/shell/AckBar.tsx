"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../icons";

/**
 * The thin bar on every signed-in page while a message waits for the person's acknowledgement (owner decision
 * 2026-11-27). Home shows the full banner instead, so the bar leaves it out there. It cannot be dismissed.
 */
export function AckBar({ text, href }: Readonly<{ text: string; href: string }>) {
  const path = usePathname();
  if (path === "/home" || path === href) return null;
  return (
    <Link
      href={href}
      data-testid="ack-bar"
      data-button-link
      className="block border-b border-attention-dot bg-attention-soft text-attention-ink no-underline hover:text-attention-ink"
    >
      <span className="mx-auto flex min-h-11 max-w-310 items-center gap-2 px-5 py-1.5 text-sm md:px-6">
        <Icon name="mail" size={18} className="shrink-0" />
        <span className="min-w-0 flex-1 font-semibold line-clamp-2">{text}</span>
        <span className="flex shrink-0 items-center gap-0.5 font-semibold underline decoration-current/50 underline-offset-3">
          Open
          <Icon name="chevronRight" size={16} />
        </span>
      </span>
    </Link>
  );
}
