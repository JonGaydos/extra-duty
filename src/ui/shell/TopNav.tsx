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

const ITEM =
  "block rounded-sm px-3 py-2 text-body font-medium text-muted no-underline transition-colors duration-150 hover:text-ink pointer-coarse:py-3 aria-[current=page]:bg-accent-soft aria-[current=page]:font-semibold aria-[current=page]:text-link";

/**
 * Desktop navigation, 768 px and up: brand, every section, theme and the profile avatar. Coordinators and admins also
 * get their own work as a deputy, in a second "My work" nav set apart by a divider at the right, where the avatar
 * leads its Profile item.
 */
export function TopNav({
  home,
  items,
  personal = [],
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
  /** Coordinators and admins: their own work as a deputy (see ShellNav.personal). */
  personal?: NavItem[];
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
  const active = activeHref([...items, ...personal], pathname);
  const avatarClass = coordinator ? "bg-coordinator-soft text-coordinator-ink" : "bg-accent-soft text-link";
  const helpOpen = pathname === "/help" || pathname.startsWith("/help/");
  return (
    <header data-shell="top-nav" className="hidden border-b border-line bg-surface md:block">
      <div className="mx-auto flex min-h-16 max-w-310 flex-wrap items-center justify-between gap-x-3 gap-y-2 px-6 py-2">
        <div className="flex flex-wrap items-center gap-x-5.5 gap-y-1">
          <Link href={home} data-nav-item className="flex items-center gap-2.5 text-lg font-bold text-ink no-underline hover:text-ink">
            {logo ? <AgencyLogo logo={logo} place="header" /> : null}
            Signal 90
          </Link>
          <nav aria-label="Main">
            <ul className="m-0 flex list-none flex-wrap gap-0.5 p-0">
              {items.map((i) => (
                <li key={i.href}>
                  <Link href={i.href} aria-current={i.href === active ? "page" : undefined} data-nav-item className={ITEM}>
                    {i.label}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        </div>
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          {personal.length ? (
            <nav aria-label="My work" className="border-r border-line pr-2.5">
              <ul className="m-0 flex list-none flex-wrap items-center gap-0.5 p-0">
                {personal.map((i) =>
                  i.href === "/profile" ? (
                    <li key={i.href}>
                      <Link href={i.href} aria-current={i.href === active ? "page" : undefined} data-nav-item className={`${ITEM} flex items-center gap-2 py-1.5 pl-1.5 pointer-coarse:py-1.5`}>
                        <span aria-hidden="true" className={`flex size-7 items-center justify-center rounded-full text-xs font-bold ${avatarClass}`}>
                          {initials}
                        </span>
                        {i.label}
                        <span className="sr-only">, {name}</span>
                      </Link>
                    </li>
                  ) : (
                    <li key={i.href}>
                      <Link href={i.href} aria-current={i.href === active ? "page" : undefined} data-nav-item className={ITEM}>
                        {i.label}
                      </Link>
                    </li>
                  ),
                )}
              </ul>
            </nav>
          ) : null}
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
          {personal.some((i) => i.href === "/profile") ? null : (
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
          )}
        </div>
      </div>
    </header>
  );
}
