"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ThemePreference } from "@/domain/users/profile";
import { AgencyLogo, type AgencyLogoData } from "../components/AgencyLogo";
import { Icon } from "../icons";
import { ThemeToggle } from "../theme-toggle";
import { AlertsBell } from "./AlertsBell";
import { activeHref, type NavItem } from "./nav";
import { TrainingSwitch, type TrainingRole } from "./TrainingSwitch";

/** Desktop navigation, 768 px and up: brand, every section, theme and the profile avatar. */
export function TopNav({
  home,
  items,
  name,
  initials,
  coordinator,
  theme,
  unreadAlerts,
  switchMode,
  logo = null,
}: Readonly<{
  home: string;
  items: NavItem[];
  name: string;
  initials: string;
  /** Coordinators and admins wear the coordinator color on their avatar. */
  coordinator: boolean;
  theme: ThemePreference;
  /** Unread in-app alerts, for the bell's badge. */
  unreadAlerts: number;
  /** Training mode's switch: passed only for coordinators and admins, in live mode, where training is set up. */
  switchMode?: (role: TrainingRole) => Promise<{ ok: true } | { ok: false; error: string }>;
  /** The agency logo, shown before the brand in its square or wide slot. */
  logo?: AgencyLogoData | null;
}>) {
  const pathname = usePathname();
  const active = activeHref(items, pathname);
  const helpOpen = pathname === "/help" || pathname.startsWith("/help/");
  return (
    <header data-shell="top-nav" className="hidden border-b border-line bg-surface md:block">
      <div className="mx-auto flex min-h-16 max-w-310 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-6 py-2">
        <div className="flex flex-wrap items-center gap-x-5.5 gap-y-1">
          <Link href={home} data-nav-item className="flex items-center gap-2.5 text-lg font-bold text-ink no-underline hover:text-ink">
            {logo ? <AgencyLogo logo={logo} place="header" /> : null}
            Extra Duty
          </Link>
          <nav aria-label="Main">
            <ul className="m-0 flex list-none flex-wrap gap-0.5 p-0">
              {items.map((i) => (
                <li key={i.href}>
                  <Link
                    href={i.href}
                    aria-current={i.href === active ? "page" : undefined}
                    data-nav-item
                    className="block rounded-sm px-3 py-2 text-body font-medium text-muted no-underline transition-colors duration-150 hover:text-ink pointer-coarse:py-3 aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-link"
                  >
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="flex items-center gap-2.5">
          {switchMode ? <TrainingSwitch switchMode={switchMode} /> : null}
          <ThemeToggle initial={theme} signedIn compact />
          <Link
            href="/help"
            aria-label="Help"
            aria-current={active === undefined && helpOpen ? "page" : undefined}
            data-nav-item
            className="flex size-9 items-center justify-center rounded-full border border-line bg-surface text-ink no-underline hover:bg-subtle hover:text-ink pointer-coarse:size-11"
          >
            <Icon name="help" size={20} />
          </Link>
          <AlertsBell unread={unreadAlerts} />
          <Link
            href="/profile"
            data-nav-item
            className={`flex size-9 items-center justify-center rounded-full text-sm font-bold no-underline pointer-coarse:size-11 ${
              coordinator ? "bg-coordinator-soft text-coordinator-ink hover:text-coordinator-ink" : "bg-accent-soft text-link"
            }`}
          >
            <span aria-hidden="true">{initials}</span>
            <span className="sr-only">Profile, {name}</span>
          </Link>
        </div>
      </div>
    </header>
  );
}
