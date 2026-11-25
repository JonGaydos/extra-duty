"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { Icon } from "../icons";
import { currentTab, type ShellNav } from "./nav";

/**
 * Phone navigation, under 768 px: up to five tabs in a full-width bar pinned flush to the bottom edge. It is the
 * app shell's last row, so it never covers content; its own surface runs under the home indicator.
 */
export function TabBar({ nav }: { nav: ShellNav }) {
  const items = nav.phone;
  const active = currentTab(nav, usePathname());
  return (
    <nav
      aria-label="Main"
      data-shell="tab-bar"
      className="shrink-0 border-t border-line bg-surface pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="flex h-16 items-stretch px-1.5 py-1.5">
        {items.map((i) => (
          <Link
            key={i.href}
            href={i.href}
            aria-current={i.href === active ? "page" : undefined}
            data-nav-item
            className="flex min-w-14.5 flex-1 flex-col items-center justify-center gap-0.75 rounded-lg px-1 text-micro font-medium text-muted no-underline transition-colors duration-150 hover:text-ink aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-link"
          >
            <Icon name={i.icon} size={22} />
            {i.short ?? i.label}
          </Link>
        ))}
      </div>
    </nav>
  );
}
