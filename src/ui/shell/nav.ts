import type { Role } from "@/domain/actor";
import type { IconName } from "../icons";

export type NavItem = {
  label: string;
  /** Shorter label for the phone tab bar. */
  short?: string;
  href: string;
  icon: IconName;
};

export type ShellNav = {
  /** Where "/" sends this role. */
  home: string;
  /** Desktop top nav: every section. */
  desktop: NavItem[];
  /** Phone tab bar: at most five, the last is More when sections do not fit. */
  phone: NavItem[];
  /** Listed on the More page. */
  more: NavItem[];
};

const PROFILE: NavItem = { label: "Profile", href: "/profile", icon: "user" };
const MORE: NavItem = { label: "More", href: "/more", icon: "more" };
/** The user manuals (/help): on the More page for roles that have one; deputies reach it from Profile. */
const HELP: NavItem = { label: "Help", href: "/help", icon: "help" };

const PERSONNEL: NavItem[] = [
  { label: "Home", href: "/home", icon: "home" },
  { label: "Details", href: "/jobs", icon: "details" },
  { label: "Map", href: "/map", icon: "map" },
  { label: "Billing", href: "/billing", icon: "receipt" },
  PROFILE,
];

const COORDINATOR: NavItem[] = [
  { label: "To-do", href: "/coordinate", icon: "todo" },
  { label: "Details", href: "/coordinate/details", icon: "details" },
  { label: "Calendar", href: "/calendar", icon: "calendar" },
  { label: "Vendors", href: "/coordinate/vendors", icon: "building" },
  { label: "Payments", href: "/coordinate/payments", icon: "receipt" },
  { label: "Reports", href: "/coordinate/reports", icon: "chart" },
  { label: "Messages", href: "/messages", icon: "mail" },
  { label: "Management", href: "/admin", icon: "sliders" },
];

const VENDOR: NavItem[] = [
  { label: "My details", href: "/vendor", icon: "details" },
  { label: "Request a detail", short: "Request", href: "/vendor/request", icon: "plus" },
  { label: "Invoices", href: "/vendor/invoices", icon: "receipt" },
  { label: "Locations", href: "/vendor/locations", icon: "pin" },
  { label: "Contracts", href: "/vendor/contracts", icon: "file" },
];

function build(desktop: NavItem[], phoneLabels: string[]): ShellNav {
  const phone = desktop.filter((i) => phoneLabels.includes(i.label));
  const more = [...desktop.filter((i) => !phone.includes(i)), PROFILE, HELP];
  return { home: desktop[0].href, desktop, phone: [...phone, MORE], more };
}

/** Staff see the Outbox where email is kept instead of sent (training mode and staging). */
const OUTBOX: NavItem = { label: "Outbox", href: "/coordinate/outbox", icon: "mail" };

export function navFor(role: Role, opts: { outbox?: boolean } = {}): ShellNav {
  switch (role) {
    case "personnel":
      return { home: "/home", desktop: PERSONNEL, phone: PERSONNEL, more: [] };
    case "coordinator":
    case "admin":
      return build(opts.outbox ? [...COORDINATOR, OUTBOX] : COORDINATOR, ["To-do", "Details", "Calendar", "Messages"]);
    case "vendor":
      return build(VENDOR, ["My details", "Request a detail", "Invoices", "Locations"]);
  }
}

/**
 * The phone tab to mark current. The section is found among all of the
 * role's sections (plus Profile and More), so a parent path such as
 * /coordinate never claims /coordinate/payments; a section that is not in the
 * bar marks More.
 */
export function currentTab(nav: ShellNav, pathname: string): string | undefined {
  const section = activeHref([...nav.desktop, PROFILE, MORE, HELP], pathname);
  if (!section) return undefined;
  if (nav.phone.some((i) => i.href === section)) return section;
  return nav.phone.some((i) => i.href === MORE.href) ? MORE.href : undefined;
}

/** The item for the current path: the longest href that is the path or a parent of it. */
export function activeHref(items: NavItem[], pathname: string): string | undefined {
  return items
    .map((i) => i.href)
    .filter((h) => pathname === h || pathname.startsWith(`${h}/`))
    .sort((a, b) => b.length - a.length)[0];
}
